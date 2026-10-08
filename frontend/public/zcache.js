(() => {
  const ST = "kv";
  const MAXW = 960;
  const MAXH = 600;
  const CONC = 2;
  const DRAW = "path,rect,ellipse,circle,line,polyline,polygon,text,image,use,foreignObject";
  const NODRAW = new Set(["metadata", "defs", "style", "title", "desc"]);
  const mem = new Map();
  const known = new Map();
  const building = new Map();
  const waiting = [];
  let active = 0;
  const realFetch = window.fetch.bind(window);

  const idb = new Promise((res) => {
    try {
      const r = indexedDB.open("zcache", 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch {
      res(null);
    }
  });

  const ready = idb.then(
    (db) =>
      db &&
      new Promise((res) => {
        try {
          const rq = db.transaction(ST).objectStore(ST).openCursor();
          rq.onsuccess = () => {
            const c = rq.result;
            if (!c) return res();
            mem.set(c.key, c.value);
            c.continue();
          };
          rq.onerror = () => res();
        } catch {
          res();
        }
      }),
  );

  const put = (k, v) => {
    mem.set(k, v);
    idb.then((db) => {
      try {
        db?.transaction(ST, "readwrite").objectStore(ST).put(v, k);
      } catch {}
    });
  };

  const clear = () => {
    mem.clear();
    known.clear();
    idb.then((db) => {
      try {
        db?.transaction(ST, "readwrite").objectStore(ST).clear();
      } catch {}
    });
  };

  const slot = (fn) =>
    new Promise((res, rej) => {
      const run = () => {
        active++;
        fn()
          .then(res, rej)
          .finally(() => {
            active--;
            waiting.shift()?.();
          });
      };
      active < CONC ? run() : waiting.push(run);
    });

  const dataUrl = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });

  const hrefOf = (el) => el.getAttribute("href") || el.getAttribute("xlink:href") || "";

  const refImg = (root, el) => {
    const h = hrefOf(el);
    if (!h.startsWith("#")) return false;
    const t = root.querySelector("#" + CSS.escape(h.slice(1)));
    return !!t && (t.localName === "image" || !!t.querySelector("image"));
  };

  const isImg = (root, el) => el.localName === "image" || (el.localName === "use" && refImg(root, el));

  const raster = async (svg, w, h) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      return cv.toDataURL("image/webp", 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const thumb = async (src) => {
    const root = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
    if (root.localName !== "svg") throw new Error("not svg");
    const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const w = vb.length === 4 ? vb[2] : parseFloat(root.getAttribute("width"));
    const h = vb.length === 4 ? vb[3] : parseFloat(root.getAttribute("height"));
    if (!(w > 0 && h > 0)) throw new Error("no size");
    if (vb.length !== 4) root.setAttribute("viewBox", `0 0 ${w} ${h}`);
    root.removeAttribute("filter");
    const bg = [...root.children].find((c) => !NODRAW.has(c.localName));
    if (bg?.localName === "rect" && (bg.getAttribute("x") || "0") === "0" && (bg.getAttribute("y") || "0") === "0") bg.remove();
    await Promise.all(
      [...root.querySelectorAll("image")].map(async (im) => {
        im.removeAttribute("filter");
        const href = hrefOf(im);
        if (!href || href.startsWith("data:")) return;
        const r = await realFetch(href, { credentials: "same-origin" });
        if (!r.ok) throw new Error("image " + r.status);
        im.setAttribute("href", await dataUrl(await r.blob()));
        im.removeAttribute("xlink:href");
      }),
    );
    const s = Math.min(MAXW / w, MAXH / h);
    const W = Math.max(1, Math.round(w * s));
    const H = Math.max(1, Math.round(h * s));
    const layer = (images) => {
      const c = root.cloneNode(true);
      [...c.querySelectorAll(DRAW)]
        .filter((el) => !el.closest("defs,clipPath,mask,pattern,symbol,marker") && isImg(c, el) !== images)
        .forEach((el) => el.remove());
      c.setAttribute("width", W);
      c.setAttribute("height", H);
      return raster(new XMLSerializer().serializeToString(c), W, H);
    };
    const hasImg = [...root.querySelectorAll("image,use")].some(
      (el) => !el.closest("defs,symbol") && isImg(root, el),
    );
    const base = await layer(false);
    const over = hasImg ? await layer(true) : null;
    const box = `width="${W}" height="${H}"`;
    const inner = `<svg xmlns="http://www.w3.org/2000/svg" ${box} viewBox="0 0 ${W} ${H}"><image ${box} href="${base}"/></svg>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" ${box} viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
      `<image ${box} href="data:image/svg+xml,${encodeURIComponent(inner)}"/>` +
      (over ? `<image data-preview-raster="true" ${box} href="${over}"/>` : "") +
      `</svg>`
    );
  };

  const build = (id) => {
    if (building.has(id)) return building.get(id);
    const p = slot(async () => {
      const old = mem.get("t:" + id);
      const headers = old ? { "If-None-Match": `W/"preview-${id}-${old.u}"` } : {};
      const r = await realFetch(`/api/drawings/${encodeURIComponent(id)}/preview`, {
        credentials: "same-origin",
        cache: "no-store",
        headers,
      });
      if (r.status === 304) return old;
      if (!r.ok) throw new Error("preview " + r.status);
      const j = await r.json();
      let n;
      try {
        n = { u: j.updatedAt, svg: j.preview ? await thumb(j.preview) : null };
      } catch (e) {
        console.warn("[zcache] thumbnail failed", id, e);
        n = { u: j.updatedAt, svg: null, fail: true };
      }
      put("t:" + id, n);
      return n;
    }).finally(() => building.delete(id));
    building.set(id, p);
    return p;
  };

  const rootFiber = () => {
    const el = document.getElementById("root");
    const k = el && Object.keys(el).find((x) => x.startsWith("__reactContainer$"));
    return k ? el[k]?.stateNode?.current : null;
  };

  const findHook = (pred) => {
    const start = rootFiber();
    const stack = start ? [start] : [];
    let n = 0;
    while (stack.length && n++ < 50000) {
      const f = stack.pop();
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
      if (typeof f.type !== "function") continue;
      let h = f.memoizedState;
      let i = 0;
      while (h && typeof h === "object" && "next" in h && i++ < 300) {
        if (typeof h.queue?.dispatch === "function" && pred(h)) return h;
        h = h.next;
      }
    }
    return null;
  };

  const isDrawings = (s) =>
    Array.isArray(s) && s.length > 0 && s.every((d) => d && typeof d === "object" && "id" in d && "updatedAt" in d && "name" in d);

  const withHook = (pred, fn, tries = 30) => {
    const h = findHook(pred);
    if (h) return fn(h);
    if (tries > 0) setTimeout(() => withHook(pred, fn, tries - 1), 100);
  };

  const ms = (v) => (typeof v === "number" ? v : Date.parse(v));

  const norm = (d) => ({ ...d, createdAt: ms(d.createdAt), updatedAt: ms(d.updatedAt) });

  const inject = (body) => ({
    ...body,
    drawings: body.drawings.map((d) => {
      const t = mem.get("t:" + d.id);
      return t?.svg ? { ...d, preview: t.svg } : d;
    }),
  });

  const track = (body) => body.drawings.forEach((d) => known.set(d.id, ms(d.updatedAt)));

  const dispatchPreview = (id, svg) =>
    withHook(
      (h) => isDrawings(h.memoizedState) && h.memoizedState.some((d) => d.id === id),
      (h) => h.queue.dispatch((arr) => arr.map((d) => (d.id === id ? { ...d, preview: svg } : d))),
      10,
    );

  const refreshThumbs = (body) =>
    body.drawings.forEach((d) => {
      const t = mem.get("t:" + d.id);
      if (t && t.u === ms(d.updatedAt)) return;
      build(d.id)
        .then((n) => n?.svg && n.svg !== t?.svg && dispatchPreview(d.id, n.svg))
        .catch(() => {});
    });

  const fake = (xhr, z, status, text) => {
    const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, value: v });
    def("readyState", 4);
    def("status", status);
    def("statusText", status === 200 ? "OK" : "");
    def("responseText", text);
    def("response", xhr.responseType === "json" ? JSON.parse(text) : text);
    def("responseURL", new URL(z.u, location.href).href);
    def("getAllResponseHeaders", () => "content-type: application/json\r\n");
    def("getResponseHeader", (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null));
    setTimeout(() => {
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new ProgressEvent("load"));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    }, 0);
  };

  const fetchReal = async (z) => {
    const r = await realFetch(z.u, { credentials: "same-origin", headers: z.h });
    if (r.status === 401) clear();
    return { status: r.status, text: await r.text() };
  };

  const parse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  const onList = async (xhr, z) => {
    const key = "l:" + z.u;
    const hit = mem.get(key);
    if (hit?.drawings?.length) {
      fake(xhr, z, 200, JSON.stringify(inject(hit)));
      const r = await fetchReal(z);
      const body = r.status === 200 && parse(r.text);
      if (!body?.drawings) return;
      put(key, body);
      track(body);
      if (JSON.stringify(body) !== JSON.stringify(hit)) {
        const ids = hit.drawings.map((d) => d.id);
        const fresh = inject(body);
        withHook(
          (h) => isDrawings(h.memoizedState) && h.memoizedState.length === ids.length && h.memoizedState.every((d, i) => d.id === ids[i]),
          (h) => {
            h.queue.dispatch(fresh.drawings.map(norm));
            const t = h.next?.next;
            if (typeof t?.memoizedState === "number") t.queue?.dispatch(fresh.totalCount);
          },
        );
      }
      refreshThumbs(body);
      return;
    }
    const r = await fetchReal(z);
    const body = r.status === 200 && parse(r.text);
    if (!body?.drawings) return fake(xhr, z, r.status, r.text);
    put(key, body);
    track(body);
    fake(xhr, z, 200, JSON.stringify(inject(body)));
    refreshThumbs(body);
  };

  const onCollections = async (xhr, z) => {
    const key = "r:" + z.u;
    const hit = mem.get(key);
    if (hit) {
      fake(xhr, z, 200, JSON.stringify(hit));
      const r = await fetchReal(z);
      const body = r.status === 200 && parse(r.text);
      if (!Array.isArray(body)) return;
      put(key, body);
      if (JSON.stringify(body) !== JSON.stringify(hit))
        withHook(
          (h) => isDrawings(h.memoizedState) && Array.isArray(h.next?.memoizedState) && typeof h.next.queue?.dispatch === "function",
          (h) => h.next.queue.dispatch(body),
        );
      return;
    }
    const r = await fetchReal(z);
    if (r.status === 200 && Array.isArray(parse(r.text))) put(key, parse(r.text));
    fake(xhr, z, r.status, r.text);
  };

  const onPreview = async (xhr, z, id) => {
    const t = mem.get("t:" + id);
    const reply = (n) => fake(xhr, z, 200, JSON.stringify({ preview: n.svg, updatedAt: n.u }));
    if (t && !t.fail) {
      reply(t);
      if (known.get(id) === t.u) return;
      const n = await build(id).catch(() => null);
      if (n?.svg && n.svg !== t.svg) dispatchPreview(id, n.svg);
      return;
    }
    const n = await build(id).catch(() => null);
    if (n && !n.fail) return reply(n);
    const r = await fetchReal(z);
    fake(xhr, z, r.status, r.text);
  };

  const route = (z) => {
    if (z.m !== "GET") return null;
    const u = new URL(z.u, location.href);
    if (u.origin !== location.origin) return null;
    const p = u.pathname;
    const q = u.searchParams;
    if (p === "/api/drawings" && !q.has("includeData") && !q.get("search") && (q.get("offset") || "0") === "0") return onList;
    if (p === "/api/collections") return onCollections;
    const m = p.match(/^\/api\/drawings\/([^/]+)\/preview$/);
    if (m) return (xhr, z) => onPreview(xhr, z, decodeURIComponent(m[1]));
    return null;
  };

  const X = XMLHttpRequest.prototype;
  const open = X.open;
  const send = X.send;
  const setHeader = X.setRequestHeader;

  X.open = function (m, u, ...rest) {
    this._z = { m: String(m).toUpperCase(), u: String(u), h: {} };
    return open.call(this, m, u, ...rest);
  };

  X.setRequestHeader = function (k, v) {
    if (this._z) this._z.h[k] = v;
    return setHeader.call(this, k, v);
  };

  X.send = function (body) {
    const z = this._z;
    if (z && /\/auth\/logout/.test(z.u)) clear();
    let fn = null;
    try {
      fn = z && route(z);
    } catch {}
    if (!fn) return send.call(this, body);
    ready
      .then(() => fn(this, z))
      .catch((e) => {
        console.warn("[zcache] fallback", z.u, e);
        try {
          send.call(this, body);
        } catch {}
      });
  };
})();
