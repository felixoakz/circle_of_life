// Wikipedia and Wikimedia Commons (ARCHITECTURE §6.1 stage B): the article summary
// (text CC BY-SA 4.0, always attributed and linked) and the licence and
// author of the Wikidata image.
//
// Titles go into URLs as one path segment, escaped by the WHATWG URL
// path-segment rules: controls, space, `"#<>?\`{}/%` and non-ASCII are
// percent-encoded, while `()!*'` stay as they are (Go's url.PathEscape
// would encode those).
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type summaryResponse struct {
	Type        *string `json:"type"`
	Title       *string `json:"title"`
	Extract     *string `json:"extract"`
	Description *string `json:"description"`
	ContentURLs *struct {
		Desktop *struct {
			Page *string `json:"page"`
		} `json:"desktop"`
	} `json:"content_urls"`
}

// ParseSummary is the summary of an article, or nil for a disambiguation
// page or one without an extract.
func ParseSummary(body []byte) (*Summary, error) {
	var response summaryResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Type == nil || *response.Type != "standard" {
		return nil, nil
	}
	text := ""
	if response.Extract != nil {
		text = strings.TrimSpace(*response.Extract)
	}
	var page *string
	if response.ContentURLs != nil && response.ContentURLs.Desktop != nil {
		page = response.ContentURLs.Desktop.Page
	}
	if response.Title == nil || page == nil || text == "" {
		return nil, nil
	}
	summary := &Summary{
		Text:    text,
		Title:   *response.Title,
		URL:     *page,
		License: WikipediaLicense,
	}
	if response.Description != nil && *response.Description != "" {
		summary.Description = response.Description
	}
	return summary, nil
}

// SummaryURL is {base}/page/summary/{title}, spaces turned into "_" and the
// title percent-encoded as one path segment ("AC/DC" stays one segment).
func SummaryURL(base, title string) (string, error) {
	return appendSegments(base, "page", "summary", strings.ReplaceAll(title, " ", "_"))
}

// appendSegments adds segments to base's path, each escaped as one
// segment: a base path of "/" takes the first segment directly, any other
// path gets a "/" before each one, and the segments "." and ".." are
// skipped. A query or fragment on base stays at the end.
func appendSegments(base string, segments ...string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%s cannot be a base URL", base)
	}
	rest := ""
	front := base
	if i := strings.IndexAny(base, "?#"); i >= 0 {
		front, rest = base[:i], base[i:]
	}
	// The path starts at the first "/" after "scheme://"; an http(s) URL
	// without one has the path "/".
	authorityStart := len(u.Scheme) + len("://")
	path := "/"
	if i := strings.Index(front[authorityStart:], "/"); i >= 0 {
		path = front[authorityStart+i:]
		front = front[:authorityStart+i]
	}
	for _, segment := range segments {
		if segment == "." || segment == ".." {
			continue
		}
		if len(path) > 1 {
			path += "/"
		}
		path += escapePathSegment(segment)
	}
	return front + path + rest, nil
}

// escapePathSegment percent-encodes s by the WHATWG path-segment rules
// (plus '/' and '%', so the title stays one segment and is never decoded).
func escapePathSegment(s string) string {
	const hex = "0123456789ABCDEF"
	var out strings.Builder
	// Bytes, not runes: a non-ASCII character is encoded byte by byte
	// ("ç" is C3 A7 in UTF-8, so "%C3%A7").
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\t' || c == '\n' || c == '\r':
			// A WHATWG URL parser drops tabs and newlines from its input.
			continue
		case c <= 0x20 || c >= 0x7F || strings.IndexByte("\"#<>?`{}/%\\", c) >= 0:
			out.WriteByte('%')
			out.WriteByte(hex[c>>4])
			out.WriteByte(hex[c&0x0F])
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// PtURL is the Portuguese article URL for a ptwiki title.
func PtURL(title string) string {
	summaryURL, err := SummaryURL("https://pt.wikipedia.org/wiki", title)
	if err != nil {
		return "https://pt.wikipedia.org/"
	}
	// Reuse the encoder, then drop the REST path it adds.
	return strings.ReplaceAll(summaryURL, "/wiki/page/summary/", "/wiki/")
}

// wikipediaSummary is the English Wikipedia summary for title; nil without
// a title (""), for a missing article, or on failure (recorded in report).
func (e *Enricher) wikipediaSummary(ctx context.Context, report *Report, title string) *Summary {
	if title == "" {
		return nil
	}
	summaryURL, err := SummaryURL(e.Endpoints.Wikipedia, title)
	if err != nil {
		report.Fail(SourceWikipedia, err.Error())
		return nil
	}
	body, ok := e.getText(ctx, report, HostWikimedia, SourceWikipedia, summaryURL, nil)
	if !ok {
		return nil
	}
	summary, err := ParseSummary(body)
	if err != nil {
		report.Fail(SourceWikipedia, fmt.Sprintf("summary %s: %v", title, err))
		return nil
	}
	return summary
}

type commonsResponse struct {
	Query *struct {
		Pages []struct {
			Missing   bool `json:"missing"`
			Imageinfo []struct {
				Thumburl       *string              `json:"thumburl"`
				Thumbwidth     *uint32              `json:"thumbwidth"`
				Thumbheight    *uint32              `json:"thumbheight"`
				Descriptionurl *string              `json:"descriptionurl"`
				Extmetadata    map[string]metaField `json:"extmetadata"`
			} `json:"imageinfo"`
		} `json:"pages"`
	} `json:"query"`
}

// metaField is one extmetadata field, {"value": …}; the value is usually
// a string, but not always.
type metaField struct {
	Value any `json:"value"`
}

// metaText is the plain text of an extmetadata field, nil if it is
// missing, not a string, or empty.
func metaText(meta map[string]metaField, key string) *string {
	field, ok := meta[key]
	if !ok {
		return nil
	}
	raw, ok := field.Value.(string)
	if !ok {
		return nil
	}
	text := StripHTML(raw)
	if text == "" {
		return nil
	}
	return &text
}

// ParseCommons is the image with its licence and author from a Commons
// imageinfo response (formatversion=2). nil for a missing file, and also
// for a file without a licence name: we never show an image we cannot
// credit.
func ParseCommons(body []byte) (*Image, error) {
	var response commonsResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Query == nil {
		return nil, errors.New("Commons response without query")
	}
	if len(response.Query.Pages) == 0 {
		return nil, nil
	}
	page := response.Query.Pages[0]
	if page.Missing || len(page.Imageinfo) == 0 {
		return nil, nil
	}
	info := page.Imageinfo[0]
	if info.Descriptionurl == nil {
		// Required: the panel links the image's page.
		return nil, errors.New("Commons imageinfo without descriptionurl")
	}
	license := metaText(info.Extmetadata, "LicenseShortName")
	if license == nil || info.Thumburl == nil {
		return nil, nil
	}
	// Drop the "?utm_source=…" tracking query Commons appends.
	thumb, _, _ := strings.Cut(*info.Thumburl, "?")
	return &Image{
		URL:        thumb,
		Width:      info.Thumbwidth,
		Height:     info.Thumbheight,
		Credit:     metaText(info.Extmetadata, "Artist"),
		License:    *license,
		LicenseURL: metaText(info.Extmetadata, "LicenseUrl"),
		Source:     SourceCommons,
		PageURL:    *info.Descriptionurl,
	}, nil
}

// commonsImage is the licence, author and a 640 px thumbnail for a Commons
// file (Wikidata P18); nil for file "" or on failure.
func (e *Enricher) commonsImage(ctx context.Context, report *Report, file string) *Image {
	if file == "" {
		return nil
	}
	title := "File:" + file
	query := url.Values{}
	query.Set("action", "query")
	query.Set("titles", title)
	query.Set("prop", "imageinfo")
	query.Set("iiprop", "extmetadata|url")
	query.Set("iiurlwidth", "640")
	query.Set("iiextmetadatafilter", "LicenseShortName|Artist|LicenseUrl")
	query.Set("format", "json")
	query.Set("formatversion", "2")
	body, ok := e.getText(ctx, report, HostWikimedia, SourceCommons, e.Endpoints.Commons, query)
	if !ok {
		return nil
	}
	image, err := ParseCommons(body)
	if err != nil {
		report.Fail(SourceCommons, fmt.Sprintf("%s: %v", title, err))
		return nil
	}
	return image
}
