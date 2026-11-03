// The built frontend (web/dist): /assets/… files cached forever (on 2xx),
// other files (favicon.svg, fallback.webp) for a day, and index.html
// no-cache. A path with no file extension that is not a file gets
// index.html, because the frontend is a single page app; a missing path
// with an extension (/favicon.ico, /robots.txt) is a plain 404, which
// browsers remember instead of asking again. Files are served with
// http.ServeContent, never http.FileServer (no directory listings, no
// /index.html redirect), with explicit content types for .js .css .woff
// .woff2 .webp .svg .json.
//
// Concepts introduced here:
// - (none beyond the package's)

package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
)

// contentTypes are the types the server sends, fixed here. Go's own
// table depends on the system's /etc/mime.types for some of these, and says
// font/woff for .woff, which the gzip rules would then skip.
var contentTypes = map[string]string{
	".js":    "text/javascript",
	".css":   "text/css",
	".woff":  "application/font-woff",
	".woff2": "font/woff2",
	".webp":  "image/webp",
	".svg":   "image/svg+xml",
	".json":  "application/json",
}

// assets serves hashed files under dir/assets. Vite puts a content hash in
// every name there, so a URL never changes content: cache it forever. A
// missing file is a plain 404, which must not be cached.
func assets(staticDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		file, ok := openFile(staticDir, r.URL.Path)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		defer file.Close()
		serveFile(&cacheOnSuccess{ResponseWriter: w}, r, file)
	}
}

// rootFileCache is the Cache-Control of files outside /assets other than
// index.html. Their names carry no hash, so not forever; a day is plenty
// for an icon.
const rootFileCache = "public, max-age=86400"

// appShell serves any other file in staticDir, and index.html for every
// extensionless path that is not one. index.html is sent with
// Cache-Control: no-cache (it names the current hashed assets, so it must
// be revalidated), other files with rootFileCache.
func appShell(staticDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		file, ok := openFile(staticDir, r.URL.Path)
		if !ok && path.Ext(r.URL.Path) == "" {
			file, ok = openFile(staticDir, "/index.html")
		}
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		defer file.Close()
		if filepath.Base(file.Name()) == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", rootFileCache)
		}
		serveFile(w, r, file)
	}
}

// openFile opens the regular file urlPath names inside dir; a directory
// stands for its index.html. ok is false if there is no such file.
func openFile(dir, urlPath string) (*os.File, bool) {
	// Cleaning "/"+urlPath removes every "..", so the result stays in dir.
	name := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+urlPath)))
	info, err := os.Stat(name)
	if err != nil {
		return nil, false
	}
	if info.IsDir() {
		name = filepath.Join(name, "index.html")
		info, err = os.Stat(name)
		if err != nil || !info.Mode().IsRegular() {
			return nil, false
		}
	} else if !info.Mode().IsRegular() {
		return nil, false
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, false
	}
	return file, true
}

// serveFile sends file with its content type, Last-Modified, and support
// for ranges and conditional requests (http.ServeContent).
func serveFile(w http.ResponseWriter, r *http.Request, file *os.File) {
	info, err := file.Stat()
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if contentType, ok := contentTypes[filepath.Ext(file.Name())]; ok {
		w.Header().Set("Content-Type", contentType)
	}
	// Without a Content-Type, ServeContent guesses one from the extension.
	http.ServeContent(w, r, file.Name(), info.ModTime(), file)
}

// cacheOnSuccess sets the immutable Cache-Control on 2xx responses only:
// a 304 or an error must not be cached forever.
type cacheOnSuccess struct {
	http.ResponseWriter
	wroteHeader bool
}

func (c *cacheOnSuccess) WriteHeader(status int) {
	if !c.wroteHeader && status >= 200 && status < 300 {
		c.Header().Set("Cache-Control", immutable)
	}
	c.wroteHeader = true
	c.ResponseWriter.WriteHeader(status)
}

// Write without WriteHeader first means 200, as in net/http.
func (c *cacheOnSuccess) Write(b []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}
