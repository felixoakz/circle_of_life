//! iNaturalist (PLAN §6.1 stage B): a photo for taxa whose Wikidata item
//! has no image, and the taxon page for the links.
//!
//! Only photos under an open licence we may show in a non-commercial
//! portfolio are used: CC0, CC BY, CC BY-SA and CC BY-NC. A photo with no
//! licence code is "all rights reserved" and is never used. At most one
//! request per second (`Enricher::get_text`).
//!
//! Concepts introduced here:
//! - `?` on an `Option`, in a function that itself returns an `Option`

use serde::Deserialize;

use super::{Enricher, Host, INAT, Image, Report};

/// Licence codes we may show (iNat's own spelling).
pub const ALLOWED_LICENSES: [&str; 4] = ["cc0", "cc-by", "cc-by-sa", "cc-by-nc"];

/// An iNaturalist taxon that matched the name exactly.
#[derive(Debug, Clone, PartialEq)]
pub struct InatTaxon {
    pub id: u64,
    /// Its default photo, if it has one under an allowed licence.
    pub image: Option<Image>,
}

#[derive(Debug, Deserialize)]
struct TaxaResponse {
    #[serde(default)]
    results: Vec<TaxonResult>,
}

#[derive(Debug, Deserialize)]
struct TaxonResult {
    id: u64,
    name: String,
    default_photo: Option<Photo>,
}

#[derive(Debug, Deserialize)]
struct Photo {
    license_code: Option<String>,
    attribution: Option<String>,
    medium_url: Option<String>,
    id: Option<u64>,
}

/// "CC BY-NC" for "cc-by-nc", with the Creative Commons deed URL.
pub fn license_label(code: &str) -> Option<(&'static str, &'static str)> {
    match code {
        "cc0" => Some(("CC0", "https://creativecommons.org/publicdomain/zero/1.0/")),
        "cc-by" => Some(("CC BY", "https://creativecommons.org/licenses/by/4.0/")),
        "cc-by-sa" => Some((
            "CC BY-SA",
            "https://creativecommons.org/licenses/by-sa/4.0/",
        )),
        "cc-by-nc" => Some((
            "CC BY-NC",
            "https://creativecommons.org/licenses/by-nc/4.0/",
        )),
        _ => None,
    }
}

/// "Olli Pihlajamaa" from "(c) Olli Pihlajamaa, some rights reserved (CC
/// BY-NC), uploaded by Olli Pihlajamaa". Falls back to the whole string.
pub fn credit_name(attribution: &str) -> String {
    let rest = attribution
        .strip_prefix("(c) ")
        .or_else(|| attribution.strip_prefix("© "))
        .unwrap_or(attribution);
    for marker in [", some rights reserved", ", no rights reserved"] {
        if let Some((name, _)) = rest.split_once(marker) {
            return name.trim().to_string();
        }
    }
    attribution.trim().to_string()
}

/// The result whose `name` is exactly `name` (the search is fuzzy:
/// "Panthera onca" also returns *Panthera atrox*), with its photo kept only
/// if the licence is allowed.
pub fn parse_taxa(body: &str, name: &str) -> anyhow::Result<Option<InatTaxon>> {
    let response: TaxaResponse = serde_json::from_str(body)?;
    for result in response.results {
        if result.name != name {
            continue;
        }
        let image = result
            .default_photo
            .and_then(|photo| photo_image(photo, result.id));
        return Ok(Some(InatTaxon {
            id: result.id,
            image,
        }));
    }
    Ok(None)
}

fn photo_image(photo: Photo, taxon_id: u64) -> Option<Image> {
    // LEARN: `?` works on `Option` too: in a function returning `Option`,
    // `x?` gives the value inside `Some(x)`, or returns `None` right away.
    // No licence code means all rights reserved: never used.
    let code = photo.license_code?;
    if !ALLOWED_LICENSES.contains(&code.as_str()) {
        return None;
    }
    let (label, deed) = license_label(&code)?;
    let url = photo.medium_url?;
    let page_url = match photo.id {
        Some(id) => format!("https://www.inaturalist.org/photos/{id}"),
        None => format!("https://www.inaturalist.org/taxa/{taxon_id}"),
    };
    Some(Image {
        url,
        width: None,
        height: None,
        credit: photo.attribution.as_deref().map(credit_name),
        license: label.to_string(),
        license_url: Some(deed.to_string()),
        source: INAT.to_string(),
        page_url,
        about: None,
    })
}

/// The exact-name iNaturalist taxon, if `name` is given.
pub async fn taxon(e: &Enricher, report: &Report, name: Option<&str>) -> Option<InatTaxon> {
    let name = name?;
    let url = format!("{}/taxa", e.endpoints.inat);
    let query = [("q", name), ("per_page", "5")];
    let body = e.get_text(report, Host::Inat, INAT, &url, &query).await?;
    match parse_taxa(&body, name) {
        Ok(found) => found,
        Err(err) => {
            report.fail(INAT, format!("taxa {name}: {err:#}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_name_from_attribution() {
        assert_eq!(
            credit_name(
                "(c) Olli Pihlajamaa, some rights reserved (CC BY-NC), uploaded by Olli Pihlajamaa"
            ),
            "Olli Pihlajamaa"
        );
        assert_eq!(credit_name("Jane Doe"), "Jane Doe");
    }
}
