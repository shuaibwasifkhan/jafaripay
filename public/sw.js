// JafariPay Session Service Worker
// Intercepts all /api/ fetch requests and injects X-Session-Token from localStorage.
// This runs in a separate context from the page and persists across bundle updates.
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;
  
  // Only intercept API requests
  if (url.indexOf('/api/') === -1 && url.indexOf('/auth/') === -1) return;
  
  event.respondWith(
    (async function() {
      try {
        // Read token from IndexedDB (persistent) or fall back to cloning headers
        var tok = await getToken();
        if (!tok) return fetch(req);
        
        // Clone request with extra header
        var headers = new Headers(req.headers);
        if (!headers.has('X-Session-Token')) {
          headers.set('X-Session-Token', tok);
        }
        var newReq = new Request(req, { headers: headers, credentials: 'include' });
        var resp = await fetch(newReq);
        
        // If response contains a token header, save it
        var respTok = resp.headers.get('X-Session-Token');
        if (respTok) await saveToken(respTok);
        
        return resp;
      } catch(e) {
        return fetch(req);
      }
    })()
  );
});

// Simple IndexedDB token store
var DB_NAME = 'jp_sw';
var DB_VER = 1;
var STORE = 'kv';

function openDb() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function(e) {
      e.target.result.createObjectStore(STORE);
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function(e) { reject(e.target.error); };
  });
}

async function getToken() {
  try {
    var db = await openDb();
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).get('jp_session_token');
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { resolve(null); };
    });
  } catch(e) { return null; }
}

async function saveToken(tok) {
  try {
    var db = await openDb();
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(tok, 'jp_session_token');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch(e) {}
}

// Listen for messages from the page to save the token
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SAVE_TOKEN' && event.data.token) {
    saveToken(event.data.token);
  }
  if (event.data && event.data.type === 'CLEAR_TOKEN') {
    saveToken('');
  }
});
