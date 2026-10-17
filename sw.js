const CACHE_NAME = "worklog-cache-v8-8-0";
const CACHE_KEY = CACHE_NAME+":"+self.registration.scope;
const APP_SHELL = ["./index.html", "./style.css", "./app.js", "./manifest.json"];
// Normalize line endings for Git checkouts before checking the release files.
const RELEASE_HASHES = {
  "./index.html": "f8ebf12c3cab7e106c5b1859d137171b4908195528a5346d85fd7dc38e1fdff7",
  "./style.css": "9442d58934cbff0bec78085c8a9c85107ee6ad3901755c5a312c1fe2123f1adc",
  "./app.js": "621e93f64c05fb3b51b64a362d6365cd7fdda3f91dee3db49e2b8330addcc861",
  "./manifest.json": "8fcd10014606baffff1bbb9f1bb126dd1a984bb4a61a85c6d62178d56b53284c"
};

self.addEventListener("install", event => {
  event.waitUntil((async()=>{
    const files=await Promise.all(APP_SHELL.map(async path=>{
      const response=await fetch(new URL(path,self.registration.scope),{cache:"no-store"});
      if(!response.ok)throw new Error("Release file unavailable");
      const text=(await response.clone().text()).replace(/\r\n/g,"\n");
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
      const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
      if(hash!==RELEASE_HASHES[path])throw new Error("Release files are not yet consistent");
      return [new URL(path,self.registration.scope).href,response];
    }));
    const cache=await caches.open(CACHE_KEY);
    for(const [url,response] of files)await cache.put(url,response);
    // Wait for old windows to close instead of reloading an in-progress draft.
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async()=>{
    const suffix=":"+self.registration.scope;
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith("worklog-cache-")&&key.endsWith(suffix)&&key!==CACHE_KEY).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope=new URL(self.registration.scope);
  if(url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  const shell=APP_SHELL.find(path=>new URL(path,scope).pathname===url.pathname);
  const isAppNavigation=event.request.mode==="navigate"&&(url.pathname===scope.pathname||url.pathname===new URL("./index.html",scope).pathname);
  if(!shell&&!isAppNavigation)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_KEY),path=isAppNavigation?"./index.html":shell;
    const response=await cache.match(new URL(path,scope).href);
    return response||fetch(event.request);
  })());
});
