//! Wikipedia and Wikimedia Commons (PLAN §6.1 stage B): the article summary
//! (text CC BY-SA 4.0, always attributed and linked) and the licence and
//! author of the Wikidata image.
//!
//! Concepts introduced here:
//! - `#[serde(rename = "type")]` for a JSON key that is a Rust keyword
//! - building a URL path safely with `Url::path_segments_mut`

use std::collections::HashMap;

use anyhow::bail;
use reqwest::Url;
use serde::Deserialize;

use super::{
    COMMONS, Enricher, Host, Image, Report, Summary, WIKIPEDIA, WIKIPEDIA_LICENSE, strip_html,
};

#[derive(Debug, Deserialize)]
struct SummaryResponse {
    // LEARN: `type` is a Rust keyword, so the field gets another name and
    // `rename` tells serde which JSON key it reads.
    #[serde(rename = "type")]
    kind: Option<String>,
    title: Option<String>,
    extract: Option<String>,
    description: Option<String>,
    content_urls: Option<ContentUrls>,
}

#[derive(Debug, Deserialize)]
struct ContentUrls {
    desktop: Option<PageUrls>,
}

#[derive(Debug, Deserialize)]
struct PageUrls {
    page: Option<String>,
}

/// The summary of an article, or `None` for a disambiguation page or one
/// without an extract.
pub fn parse_summary(body: &str) -> anyhow::Result<Option<Summary>> {
    let response: SummaryResponse = serde_json::from_str(body)?;
    if response.kind.as_deref() != Some("standard") {
        return Ok(None);
    }
    let text = response.extract.unwrap_or_default();
    let page = response
        .content_urls
        .and_then(|c| c.desktop)
        .and_then(|d| d.page);
    let (Some(title), Some(url)) = (response.title, page) else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(Summary {
        text: text.trim().to_string(),
        description: response.description.filter(|d| !d.is_empty()),
        title,
        url,
        license: WIKIPEDIA_LICENSE.to_string(),
        about: None,
    }))
}

/// `{base}/page/summary/{title}`, with the title percent-encoded as one
/// path segment ("AC/DC" must not become two segments).
pub fn summary_url(base: &str, title: &str) -> anyhow::Result<Url> {
    let mut url = Url::parse(base)?;
    // LEARN: `path_segments_mut` gives a guard that appends path segments,
    // encoding each one. It fails only for URLs that cannot have a path
    // (`mailto:…`), which is why it returns a `Result`.
    let Ok(mut segments) = url.path_segments_mut() else {
        bail!("{base} cannot be a base URL");
    };
    segments.push("page");
    segments.push("summary");
    segments.push(&title.replace(' ', "_"));
    // The guard borrows `url` mutably; it must end before `url` is returned.
    drop(segments);
    Ok(url)
}

/// The Portuguese article URL for a ptwiki title.
pub fn pt_url(title: &str) -> String {
    match summary_url("https://pt.wikipedia.org/wiki", title) {
        // Reuse the encoder, then drop the REST path it adds.
        Ok(url) => url.as_str().replace("/wiki/page/summary/", "/wiki/"),
        Err(_) => String::from("https://pt.wikipedia.org/"),
    }
}

/// The English Wikipedia summary for `title`; `None` without a title, for a
/// missing article, or on failure (recorded in `report`).
pub async fn summary(e: &Enricher, report: &Report, title: Option<&str>) -> Option<Summary> {
    let title = title?;
    let url = match summary_url(&e.endpoints.wikipedia, title) {
        Ok(url) => url,
        Err(err) => {
            report.fail(WIKIPEDIA, format!("{err:#}"));
            return None;
        }
    };
    let body = e
        .get_text(report, Host::Wikimedia, WIKIPEDIA, url.as_str(), &[])
        .await?;
    match parse_summary(&body) {
        Ok(summary) => summary,
        Err(err) => {
            report.fail(WIKIPEDIA, format!("summary {title}: {err:#}"));
            None
        }
    }
}

#[derive(Debug, Deserialize)]
struct CommonsResponse {
    query: Option<CommonsQuery>,
}

#[derive(Debug, Deserialize)]
struct CommonsQuery {
    pages: Vec<CommonsPage>,
}

#[derive(Debug, Deserialize)]
struct CommonsPage {
    #[serde(default)]
    missing: bool,
    #[serde(default)]
    imageinfo: Vec<ImageInfo>,
}

#[derive(Debug, Deserialize)]
struct ImageInfo {
    thumburl: Option<String>,
    thumbwidth: Option<u32>,
    thumbheight: Option<u32>,
    descriptionurl: String,
    #[serde(default)]
    extmetadata: HashMap<String, MetaField>,
}

#[derive(Debug, Deserialize)]
struct MetaField {
    value: serde_json::Value,
}

fn meta_text(meta: &HashMap<String, MetaField>, key: &str) -> Option<String> {
    let raw = meta.get(key)?.value.as_str()?;
    let text = strip_html(raw);
    if text.is_empty() { None } else { Some(text) }
}

/// The image with its licence and author, from a Commons `imageinfo`
/// response (`formatversion=2`). `None` for a missing file, and also for a
/// file without a licence name: we never show an image we cannot credit.
pub fn parse_commons(body: &str) -> anyhow::Result<Option<Image>> {
    let response: CommonsResponse = serde_json::from_str(body)?;
    let Some(query) = response.query else {
        bail!("Commons response without query");
    };
    let Some(page) = query.pages.into_iter().next() else {
        return Ok(None);
    };
    if page.missing {
        return Ok(None);
    }
    let Some(info) = page.imageinfo.into_iter().next() else {
        return Ok(None);
    };
    let Some(license) = meta_text(&info.extmetadata, "LicenseShortName") else {
        return Ok(None);
    };
    let Some(thumb) = info.thumburl else {
        return Ok(None);
    };
    // Drop the `?utm_source=…` tracking query Commons appends.
    let url = match thumb.split_once('?') {
        Some((plain, _)) => plain.to_string(),
        None => thumb,
    };
    Ok(Some(Image {
        url,
        width: info.thumbwidth,
        height: info.thumbheight,
        credit: meta_text(&info.extmetadata, "Artist"),
        license,
        license_url: meta_text(&info.extmetadata, "LicenseUrl"),
        source: COMMONS.to_string(),
        page_url: info.descriptionurl,
        about: None,
    }))
}

/// Licence, author and a 640 px thumbnail for a Commons file (Wikidata P18).
pub async fn commons_image(e: &Enricher, report: &Report, file: Option<&str>) -> Option<Image> {
    let file = file?;
    let title = format!("File:{file}");
    let query = [
        ("action", "query"),
        ("titles", title.as_str()),
        ("prop", "imageinfo"),
        ("iiprop", "extmetadata|url"),
        ("iiurlwidth", "640"),
        ("iiextmetadatafilter", "LicenseShortName|Artist|LicenseUrl"),
        ("format", "json"),
        ("formatversion", "2"),
    ];
    let url = &e.endpoints.commons;
    let body = e
        .get_text(report, Host::Wikimedia, COMMONS, url, &query)
        .await?;
    match parse_commons(&body) {
        Ok(image) => image,
        Err(err) => {
            report.fail(COMMONS, format!("{title}: {err:#}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_url_encodes_the_title_as_one_segment() {
        let url = summary_url("https://en.wikipedia.org/api/rest_v1", "AC/DC band").unwrap();
        assert_eq!(
            url.as_str(),
            "https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC_band"
        );
    }

    #[test]
    fn portuguese_url() {
        assert_eq!(
            pt_url("Onça-pintada"),
            "https://pt.wikipedia.org/wiki/On%C3%A7a-pintada"
        );
    }
}
