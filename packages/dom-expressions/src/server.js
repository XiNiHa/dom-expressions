import { Aliases, BooleanAttributes, ChildProperties } from "./constants";
import { sharedConfig } from "rxcore";
import stringify from "./serializer";
export { stringify };
export { createComponent } from "rxcore";

const REPLACE_SCRIPT = `function $df(e,t,n,o,d){if(n=document.getElementById(e),o=document.getElementById("pl-"+e)){for(;o&&8!==o.nodeType&&o.nodeValue!=="pl-"+e;)d=o.nextSibling,o.remove(),o=d;o.replaceWith(n.content)}n.remove(),_$HY.set(e,t),_$HY.fe(e)}`;

export function renderToString(code, options = {}) {
  let scripts = "";
  sharedConfig.context = {
    id: options.renderId || "",
    count: 0,
    suspense: {},
    lazy: {},
    assets: [],
    nonce: options.nonce,
    writeResource(id, p, error) {
      if (sharedConfig.context.noHydrate) return;
      if (error) return (scripts += `_$HY.set("${id}", ${serializeError(p)});`);
      scripts += `_$HY.set("${id}", ${stringify(p)});`;
    }
  };
  let html = resolveSSRNode(escape(code()));
  sharedConfig.context.noHydrate = true;
  html = injectAssets(sharedConfig.context.assets, html);
  if (scripts.length) html = injectScripts(html, scripts, options.nonce);
  return html;
}

export function renderToStringAsync(code, options = {}) {
  const { timeoutMs = 30000 } = options;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject("renderToString timed out"), timeoutMs);
  });
  return Promise.race([renderToStream(code, options), timeout]).then(html => {
    clearTimeout(timeoutHandle);
    return html;
  });
}

export function renderToStream(code, options = {}) {
  let { nonce, onCompleteShell, onCompleteAll, renderId } = options;
  const blockingResources = [];
  const registry = new Map();
  const dedupe = new WeakMap();
  const checkEnd = () => {
    if (!registry.size && !completed) {
      writeTasks();
      onCompleteAll &&
        onCompleteAll({
          write(v) {
            !completed && buffer.write(v);
          }
        });
      writable && writable.end();
      completed = true;
    }
  };
  const pushTask = task => {
    tasks += task + ";";
    if (!scheduled && firstFlushed) {
      Promise.resolve().then(writeTasks);
      scheduled = true;
    }
  };
  const writeTasks = () => {
    if (tasks.length && !completed && firstFlushed) {
      buffer.write(`<script${nonce ? ` nonce="${nonce}"` : ""}>${tasks}</script>`);
      tasks = "";
    }
    scheduled = false;
  };

  let context;
  let writable;
  let tmp = "";
  let tasks = "";
  let firstFlushed = false;
  let completed = false;
  let scriptFlushed = false;
  let scheduled = true;
  let buffer = {
    write(payload) {
      tmp += payload;
    }
  };
  sharedConfig.context = context = {
    id: renderId || "",
    count: 0,
    async: true,
    resources: {},
    lazy: {},
    suspense: {},
    assets: [],
    nonce,
    block(p) {
      if (!firstFlushed) blockingResources.push(p);
    },
    replace(id, payloadFn) {
      if (firstFlushed) return;
      const placeholder = `<!${id}>`;
      const first = html.indexOf(placeholder);
      if (first === -1) return;
      const last = html.indexOf(`<!/${id}>`, first + placeholder.length);
      html = html.replace(
        html.slice(first, last + placeholder.length + 1),
        resolveSSRNode(payloadFn())
      );
    },
    writeResource(id, p, error, wait) {
      const serverOnly = sharedConfig.context.noHydrate;
      if (error) return !serverOnly && pushTask(serializeSet(dedupe, id, p, serializeError));
      if (!p || typeof p !== "object" || !("then" in p))
        return !serverOnly && pushTask(serializeSet(dedupe, id, p));
      if (!firstFlushed) wait && blockingResources.push(p);
      else !serverOnly && pushTask(`_$HY.init("${id}")`);
      if (serverOnly) return;
      p.then(d => {
        !completed && pushTask(serializeSet(dedupe, id, d));
      }).catch(() => {
        !completed && pushTask(`_$HY.set("${id}", {})`);
      });
    },
    registerFragment(key) {
      if (!registry.has(key)) {
        registry.set(key, []);
        firstFlushed && pushTask(`_$HY.init("${key}")`);
      }
      return (value, error) => {
        if (registry.has(key)) {
          const keys = registry.get(key);
          registry.delete(key);
          if (waitForFragments(registry, key)) return;
          if ((value !== undefined || error) && !completed) {
            if (!firstFlushed) {
              Promise.resolve().then(
                () => (html = replacePlaceholder(html, key, value !== undefined ? value : ""))
              );
              error && pushTask(serializeSet(dedupe, key, error, serializeError));
            } else {
              buffer.write(`<template id="${key}">${value !== undefined ? value : " "}</template>`);
              pushTask(
                `${
                  keys.length ? keys.map(k => `_$HY.unset("${k}")`).join(";") + ";" : ""
                }$df("${key}"${error ? "," + serializeError(error) : ""})${
                  !scriptFlushed ? ";" + REPLACE_SCRIPT : ""
                }`
              );
              scriptFlushed = true;
            }
          }
        }
        if (!registry.size) Promise.resolve().then(checkEnd);
        return firstFlushed;
      };
    }
  };

  let html = resolveSSRNode(escape(code()));
  function doShell() {
    sharedConfig.context = context;
    context.noHydrate = true;
    html = injectAssets(context.assets, html);
    for (const key in context.resources) {
      if (!("data" in context.resources[key] || context.resources[key].ref[0].error))
        pushTask(`_$HY.init("${key}")`);
    }
    for (const key of registry.keys()) pushTask(`_$HY.init("${key}")`);
    if (tasks.length) html = injectScripts(html, tasks, nonce);
    buffer.write(html);
    tasks = "";
    scheduled = false;
    onCompleteShell &&
      onCompleteShell({
        write(v) {
          !completed && buffer.write(v);
        }
      });
  }

  return {
    then(fn) {
      function complete() {
        doShell();
        fn(tmp);
      }
      if (onCompleteAll) {
        ogComplete = onCompleteAll;
        onCompleteAll = options => {
          ogComplete(options);
          complete();
        };
      } else onCompleteAll = complete;
      if (!registry.size) Promise.resolve().then(checkEnd);
    },
    pipe(w) {
      Promise.allSettled(blockingResources).then(() => {
        doShell();
        buffer = writable = w;
        buffer.write(tmp);
        firstFlushed = true;
        if (completed) writable.end();
        else setTimeout(checkEnd);
      });
    },
    pipeTo(w) {
      Promise.allSettled(blockingResources).then(() => {
        doShell();
        const encoder = new TextEncoder();
        const writer = w.getWriter();
        writable = {
          end() {
            writer.releaseLock();
            w.close();
          }
        };
        buffer = {
          write(payload) {
            writer.write(encoder.encode(payload));
          }
        };
        buffer.write(tmp);
        firstFlushed = true;
        if (completed) writable.end();
        else setTimeout(checkEnd);
      });
    }
  };
}

// components
export function HydrationScript(props) {
  const { nonce } = sharedConfig.context;
  return ssr(generateHydrationScript({ nonce, ...props }));
}

// rendering
export function ssr(t, ...nodes) {
  if (nodes.length) {
    let result = "";

    for (let i = 0; i < nodes.length; i++) {
      result += t[i];
      const node = nodes[i];
      if (node !== undefined) result += resolveSSRNode(node);
    }

    t = result + t[nodes.length];
  }

  return { t };
}

export function ssrClassList(value) {
  if (!value) return "";
  let classKeys = Object.keys(value),
    result = "";
  for (let i = 0, len = classKeys.length; i < len; i++) {
    const key = classKeys[i],
      classValue = !!value[key];
    if (!key || key === "undefined" || !classValue) continue;
    i && (result += " ");
    result += key;
  }
  return result;
}

export function ssrStyle(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  let result = "";
  const k = Object.keys(value);
  for (let i = 0; i < k.length; i++) {
    const s = k[i];
    const v = value[s];
    if (v != undefined) {
      if (i) result += ";";
      result += `${s}:${escape(v, true)}`;
    }
  }
  return result;
}

export function ssrElement(tag, props, children, needsId) {
  let result = `<${tag}${needsId ? ssrHydrationKey() : ""} `;
  if (props == null) props = {};
  else if (typeof props === "function") props = props();
  const keys = Object.keys(props);
  let classResolved;
  for (let i = 0; i < keys.length; i++) {
    const prop = keys[i];
    if (ChildProperties.has(prop)) {
      if (children === undefined)
        children = prop === "innerHTML" ? props[prop] : escape(props[prop]);
      continue;
    }
    const value = props[prop];
    if (prop === "style") {
      result += `style="${ssrStyle(value)}"`;
    } else if (prop === "class" || prop === "className" || prop === "classList") {
      if (classResolved) continue;
      let n;
      result += `class="${(n = props.class) ? n + " " : ""}${
        (n = props.className) ? n + " " : ""
      }${ssrClassList(props.classList)}"`;
      classResolved = true;
    } else if (BooleanAttributes.has(prop)) {
      if (value) result += prop;
      else continue;
    } else if (value == undefined || prop === "ref" || prop.slice(0, 2) === "on") {
      continue;
    } else {
      result += `${Aliases[prop] || prop}="${escape(value, true)}"`;
    }
    if (i !== keys.length - 1) result += " ";
  }

  return { t: result + `>${resolveSSRNode(children)}</${tag}>` };
}

export function ssrAttribute(key, value, isBoolean) {
  return isBoolean ? (value ? " " + key : "") : value != null ? ` ${key}="${value}"` : "";
}

export function ssrHydrationKey() {
  const hk = getHydrationKey();
  return hk ? ` data-hk="${hk}"` : "";
}

export function escape(s, attr) {
  const t = typeof s;
  if (t !== "string") {
    if (!attr && t === "function") return escape(s(), attr);
    if (!attr && Array.isArray(s)) {
      let r = "";
      for (let i = 0; i < s.length; i++) r += resolveSSRNode(escape(s[i], attr));
      return { t: r };
    }
    if (attr && t === "boolean") return String(s);
    return s;
  }
  const delim = attr ? '"' : "<";
  const escDelim = attr ? "&quot;" : "&lt;";
  let iDelim = s.indexOf(delim);
  let iAmp = s.indexOf("&");

  if (iDelim < 0 && iAmp < 0) return s;

  let left = 0,
    out = "";

  while (iDelim >= 0 && iAmp >= 0) {
    if (iDelim < iAmp) {
      if (left < iDelim) out += s.substring(left, iDelim);
      out += escDelim;
      left = iDelim + 1;
      iDelim = s.indexOf(delim, left);
    } else {
      if (left < iAmp) out += s.substring(left, iAmp);
      out += "&amp;";
      left = iAmp + 1;
      iAmp = s.indexOf("&", left);
    }
  }

  if (iDelim >= 0) {
    do {
      if (left < iDelim) out += s.substring(left, iDelim);
      out += escDelim;
      left = iDelim + 1;
      iDelim = s.indexOf(delim, left);
    } while (iDelim >= 0);
  } else
    while (iAmp >= 0) {
      if (left < iAmp) out += s.substring(left, iAmp);
      out += "&amp;";
      left = iAmp + 1;
      iAmp = s.indexOf("&", left);
    }

  return left < s.length ? out + s.substring(left) : out;
}

export function resolveSSRNode(node) {
  const t = typeof node;
  if (t === "string") return node;
  if (node == null || t === "boolean") return "";
  if (Array.isArray(node)) {
    let mapped = "";
    for (let i = 0, len = node.length; i < len; i++) mapped += resolveSSRNode(node[i]);
    return mapped;
  }
  if (t === "object") return node.t;
  if (t === "function") return resolveSSRNode(node());
  return String(node);
}

export function mergeProps(...sources) {
  const target = {};
  for (let i = 0; i < sources.length; i++) {
    let source = sources[i];
    if (typeof source === "function") source = source();
    if (source) {
      const descriptors = Object.getOwnPropertyDescriptors(source);
      for (const key in descriptors) {
        if (key in target) continue;
        Object.defineProperty(target, key, {
          enumerable: true,
          get() {
            for (let i = sources.length - 1; i >= 0; i--) {
              const v = (sources[i] || {})[key];
              if (v !== undefined) return v;
            }
          },
        });
      }
    }
  }
  return target;
}

export function getHydrationKey() {
  const hydrate = sharedConfig.context;
  return hydrate && !hydrate.noHydrate && `${hydrate.id}${hydrate.count++}`;
}

export function useAssets(fn) {
  sharedConfig.context.assets.push(() => resolveSSRNode(fn()));
}

export function getAssets() {
  const assets = sharedConfig.context.assets;
  let out = "";
  for (let i = 0, len = assets.length; i < len; i++) out += assets[i]();
  return out;
}

export function generateHydrationScript({ eventNames = ["click", "input"], nonce } = {}) {
  return `<script${
    nonce ? ` nonce="${nonce}"` : ""
  }>(e=>{let t=e=>e&&e.hasAttribute&&(e.hasAttribute("data-hk")?e:t(e.host&&e.host instanceof Node?e.host:e.parentNode));["${eventNames.join(
    '", "'
  )}"].forEach((o=>document.addEventListener(o,(o=>{let s=o.composedPath&&o.composedPath()[0]||o.target,a=t(s);a&&!e.completed.has(a)&&e.events.push([a,o])}))))})(window._$HY||(_$HY={events:[],completed:new WeakSet,r:{},fe(){},init(e,t){_$HY.r[e]=[new Promise((e=>t=e)),t]},set(e,t,o){(o=_$HY.r[e])&&o[1](t),_$HY.r[e]=[t]},unset(e){delete _$HY.r[e]},load:e=>_$HY.r[e]}));</script><!--xs-->`;
}

export function Hydration(props) {
  if (!sharedConfig.context.noHydrate) return props.children;
  const context = sharedConfig.context;
  sharedConfig.context = {
    ...context,
    count: 0,
    id: `${context.id}${context.count++}-`,
    noHydrate: false
  };
  const res = props.children;
  sharedConfig.context = context;
  return res;
}

export function NoHydration(props) {
  sharedConfig.context.noHydrate = true;
  return props.children;
}

function injectAssets(assets, html) {
  if (!assets || !assets.length) return html;
  let out = "";
  for (let i = 0, len = assets.length; i < len; i++) out += assets[i]();
  return html.replace(`</head>`, out + `</head>`);
}

function injectScripts(html, scripts, nonce) {
  const tag = `<script${nonce ? ` nonce="${nonce}"` : ""}>${scripts}</script>`;
  const index = html.indexOf("<!--xs-->");
  if (index > -1) {
    return html.slice(0, index) + tag + html.slice(index);
  }
  return html + tag;
}

function serializeError(error) {
  if (error.message) {
    const fields = {};
    const keys = Object.getOwnPropertyNames(error);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = error[key];
      if (!value || (key !== "message" && typeof value !== "function")) {
        fields[key] = value;
      }
    }
    return `Object.assign(new Error(${stringify(error.message)}), ${stringify(fields)})`;
  }
  return stringify(error);
}

function waitForFragments(registry, key) {
  for (const k of [...registry.keys()].reverse()) {
    if (key.startsWith(k)) {
      registry.get(k).push(key);
      return true;
    }
  }
  return false;
}

function serializeSet(registry, key, value, serializer = stringify) {
  const exist = registry.get(value);
  if (exist) return `_$HY.set("${key}", _$HY.r["${exist}"][0])`;
  value !== null && typeof value === "object" && registry.set(value, key);
  return `_$HY.set("${key}", ${serializer(value)})`;
}

function replacePlaceholder(html, key, value) {
  const marker = `<template id="pl-${key}">`;
  const close = `<!pl-${key}>`

  const first = html.indexOf(marker);
  if (first === -1) return html;
  const last = html.indexOf(close, first + marker.length);

  return html.slice(0, first) + value + html.slice(last + close.length);
}

// consider deprecating
export function Assets(props) {
  useAssets(() => props.children);
}

/* istanbul ignore next */
/**
 * @deprecated Replaced by renderToStream
 */
export function pipeToNodeWritable(code, writable, options = {}) {
  if (options.onReady) {
    options.onCompleteShell = ({ write }) => {
      options.onReady({
        write,
        startWriting() {
          stream.pipe(writable);
        }
      });
    };
  }
  const stream = renderToStream(code, options);
  if (!options.onReady) stream.pipe(writable);
}

/* istanbul ignore next */
/**
 * @deprecated Replaced by renderToStream
 */
export function pipeToWritable(code, writable, options = {}) {
  if (options.onReady) {
    options.onCompleteShell = ({ write }) => {
      options.onReady({
        write,
        startWriting() {
          stream.pipeTo(writable);
        }
      });
    };
  }
  const stream = renderToStream(code, options);
  if (!options.onReady) stream.pipeTo(writable);
}

/* istanbul ignore next */
/**
 * @deprecated Replaced by ssrElement
 */
export function ssrSpread(props, isSVG, skipChildren) {
  let result = "";
  if (props == null) return result;
  if (typeof props === "function") props = props();
  const keys = Object.keys(props);
  let classResolved;
  for (let i = 0; i < keys.length; i++) {
    const prop = keys[i];
    if (prop === "children") {
      !skipChildren && console.warn(`SSR currently does not support spread children.`);
      continue;
    }
    const value = props[prop];
    if (prop === "style") {
      result += `style="${ssrStyle(value)}"`;
    } else if (prop === "class" || prop === "className" || prop === "classList") {
      if (classResolved) continue;
      let n;
      result += `class="${(n = props.class) ? n + " " : ""}${
        (n = props.className) ? n + " " : ""
      }${ssrClassList(props.classList)}"`;
      classResolved = true;
    } else if (BooleanAttributes.has(prop)) {
      if (value) result += prop;
      else continue;
    } else if (value == undefined || prop === "ref" || prop.slice(0, 2) === "on") {
      continue;
    } else {
      result += `${Aliases[prop] || prop}="${escape(value, true)}"`;
    }
    if (i !== keys.length - 1) result += " ";
  }
  return result;
}
