//! What web search has cost this month, and the on-disk cache that keeps the
//! bill down. Counted locally, so it is an estimate: accurate while this app
//! is the only consumer of the keys. Ports of src/lib/search-usage.ts and
//! src/lib/search-cache.ts; both apps share data/search-usage.json and
//! data/search-cache/.

use crate::search::SearchResult;
use crate::store::{data_dir, now_ms};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

/// A known provider and what its free allowance is worth.
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// One billed request in USD at the pay-as-you-go rate. Display only: a stale rate misleads, it does not overcharge.
    pub cost_per_request: f64,
    /// Value of the recurring monthly free allowance, in USD.
    pub free_monthly_usd: f64,
    /// The provider bills advanced depth at twice the basic rate.
    pub depth_doubles: bool,
}

/// Verified 2026-08-05 against each provider's public pricing page.
pub const PROVIDERS: [ProviderInfo; 4] = [
    ProviderInfo { id: "exa", label: "Exa", cost_per_request: 0.007, free_monthly_usd: 10.0, depth_doubles: false },
    ProviderInfo { id: "tavily", label: "Tavily", cost_per_request: 0.008, free_monthly_usd: 8.0, depth_doubles: true },
    ProviderInfo { id: "linkup", label: "Linkup", cost_per_request: 0.005, free_monthly_usd: 5.0, depth_doubles: false },
    ProviderInfo { id: "serper", label: "Serper", cost_per_request: 0.001, free_monthly_usd: 0.0, depth_doubles: false },
];

pub fn provider(id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// One provider's counters, as stored.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Counts {
    /// Billed requests actually sent.
    requests: u64,
    /// Requests answered from cache, which billed nothing.
    cached: u64,
    // ponytail: serde_json reads a long float to within one unit in the last place, so a total both apps
    // add to can differ from the web's in the 17th digit. Turn on its `float_roundtrip` feature if they must match exactly.
    usd: f64,
}

/// data/search-usage.json.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Record {
    /// Calendar month this covers, as YYYY-MM (UTC).
    month: String,
    /// Questions that triggered at least one search.
    #[serde(default)]
    questions: u64,
    providers: BTreeMap<String, Counts>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderUsage {
    pub id: String,
    pub label: String,
    pub requests: u64,
    pub cached: u64,
    pub usd: f64,
    pub free_monthly_usd: f64,
    /// Free allowance left in USD, floored at zero.
    pub remaining_usd: f64,
    /// Roughly how many more requests the free allowance covers.
    pub remaining_requests: u64,
    /// The free allowance is spent.
    pub exhausted: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub month: String,
    pub questions: u64,
    pub total_requests: u64,
    pub total_cached: u64,
    pub total_usd: f64,
    /// Billed requests per question: the efficiency dial.
    pub requests_per_question: f64,
    /// Share of requests answered from cache, 0 to 1.
    pub cache_hit_rate: f64,
    /// Days until the free allowances reset.
    pub days_until_reset: u32,
    pub providers: Vec<ProviderUsage>,
}

fn usage_file() -> PathBuf {
    data_dir().join("search-usage.json")
}

fn cache_dir() -> PathBuf {
    data_dir().join("search-cache")
}

fn month_of(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().format("%Y-%m").to_string()
}

fn days_until_reset(ms: u64) -> u32 {
    let now = chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default();
    let (year, month) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let next = chrono::NaiveDate::from_ymd_opt(year, month, 1).and_then(|d| d.and_hms_opt(0, 0, 0)).map_or(0, |d| d.and_utc().timestamp_millis());
    ((next - ms as i64).max(0) as f64 / 86_400_000.0).ceil() as u32
}

/// Temp file then rename, so a crash mid-write never leaves half a file. The
/// temp name is unique per write: concurrent searches raced on a shared one.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static N: AtomicU32 = AtomicU32::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// This month's record. One from an earlier month is discarded rather than
/// carried forward: free allowances reset monthly, and an old total would show
/// a quota as spent when it had just refilled.
fn load(file: &Path, month: &str) -> Record {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
        .filter(|record| record.month == month)
        .unwrap_or_else(|| Record { month: month.to_string(), questions: 0, providers: BTreeMap::new() })
}

/// Read, change, write back. Locked, because one round's searches finish
/// together and a bare read-modify-write keeps only the last. Errors are
/// dropped: metering must never break a search.
// ponytail: blocking file I/O on the caller's thread, a few hundred bytes. Move to spawn_blocking if it ever shows in a profile.
fn update(file: &Path, change: impl FnOnce(&mut Record)) {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut record = load(file, &month_of(now_ms()));
    change(&mut record);
    if let Ok(json) = serde_json::to_vec_pretty(&record) {
        let _ = write_atomic(file, &json);
    }
}

fn add_request(record: &mut Record, provider_id: &str, depth: &str) {
    let info = provider(provider_id);
    let multiplier = if info.is_some_and(|i| i.depth_doubles) && depth == "advanced" { 2 } else { 1 };
    let counts = record.providers.entry(provider_id.to_string()).or_default();
    counts.requests += multiplier;
    counts.usd += info.map_or(0.0, |i| i.cost_per_request) * multiplier as f64;
}

/// Records one billed request. Advanced depth counts double where the provider bills it double.
pub fn record_request(provider_id: &str, depth: &str) {
    update(&usage_file(), |r| add_request(r, provider_id, depth));
}

/// Records a request served from cache, which cost nothing.
pub fn record_cache_hit(provider_id: &str) {
    update(&usage_file(), |r| r.providers.entry(provider_id.to_string()).or_default().cached += 1);
}

/// Records that one question triggered a search.
pub fn record_question() {
    update(&usage_file(), |r| r.questions += 1);
}

fn summarise(record: &Record, days_until_reset: u32) -> Summary {
    let providers: Vec<ProviderUsage> = PROVIDERS
        .iter()
        .map(|info| {
            let used = record.providers.get(info.id).cloned().unwrap_or_default();
            let remaining_usd = (info.free_monthly_usd - used.usd).max(0.0);
            ProviderUsage {
                id: info.id.to_string(),
                label: info.label.to_string(),
                requests: used.requests,
                cached: used.cached,
                usd: used.usd,
                free_monthly_usd: info.free_monthly_usd,
                remaining_usd,
                remaining_requests: if info.cost_per_request > 0.0 { (remaining_usd / info.cost_per_request).floor() as u64 } else { 0 },
                exhausted: info.free_monthly_usd > 0.0 && remaining_usd <= 0.0,
            }
        })
        .collect();
    let total_requests: u64 = providers.iter().map(|p| p.requests).sum();
    let total_cached: u64 = providers.iter().map(|p| p.cached).sum();
    let ratio = |part: u64, whole: u64| if whole > 0 { part as f64 / whole as f64 } else { 0.0 };
    Summary {
        month: record.month.clone(),
        questions: record.questions,
        total_requests,
        total_cached,
        total_usd: providers.iter().map(|p| p.usd).sum(),
        requests_per_question: ratio(total_requests, record.questions),
        cache_hit_rate: ratio(total_cached, total_requests + total_cached),
        days_until_reset,
        providers,
    }
}

/// This month's spend, ready to show.
pub fn summary() -> Summary {
    let now = now_ms();
    summarise(&load(&usage_file(), &month_of(now)), days_until_reset(now))
}

/// Wipes the counters: needed after a plan change, since the meter cannot see a balance it did not cause.
pub fn reset() {
    let _ = std::fs::remove_file(usage_file());
}

/// Long enough to cover a working session and its retries, short enough that
/// "the latest version of X" does not answer from last week.
pub const CACHE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// Stops the cache folder growing without bound.
pub const MAX_CACHE_ENTRIES: usize = 500;
/// Bump whenever the meaning of a cached field changes: version 1 stored an
/// omitted Exa score as zero, and those entries must not outlive the fix.
pub const CACHE_SCHEMA_VERSION: u32 = 2;

/// Identity of a search. Provider and depth are part of it: the same words
/// sent elsewhere, or at another depth, are a different request.
#[derive(Clone, Copy, Debug)]
pub struct CacheKey<'a> {
    pub query: &'a str,
    pub provider: &'a str,
    pub depth: &'a str,
    pub max_results: u32,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CacheEntry {
    /// Stored for debugging; the file name is the hash, not this.
    query: String,
    provider: String,
    depth: String,
    max_results: u32,
    created_at: u64,
    results: Vec<SearchResult>,
}

fn file_name(key: &CacheKey) -> String {
    let query = key.query.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let normalised = [format!("v{CACHE_SCHEMA_VERSION}"), query, key.provider.to_string(), key.depth.to_string(), key.max_results.to_string()].join("\0");
    let hash: String = Sha256::digest(normalised).iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("{hash}.json")
}

/// A usable cached result. Anything unexpected is a miss, never an error: a
/// broken cache must degrade into no cache, not into a failed search.
pub fn read_cache(key: &CacheKey) -> Option<Vec<SearchResult>> {
    get(&cache_dir(), key, now_ms())
}

fn get(dir: &Path, key: &CacheKey, now: u64) -> Option<Vec<SearchResult>> {
    let entry: CacheEntry = serde_json::from_slice(&std::fs::read(dir.join(file_name(key))).ok()?).ok()?;
    (now.saturating_sub(entry.created_at) <= CACHE_TTL_MS).then_some(entry.results)
}

/// Stores a result. Failures are swallowed: a cache that cannot write is a slower app, not a broken one.
pub fn write_cache(key: &CacheKey, results: &[SearchResult]) {
    put(&cache_dir(), key, results, now_ms());
}

fn put(dir: &Path, key: &CacheKey, results: &[SearchResult], now: u64) {
    // An empty result set is usually a transient provider problem; caching it would lock the failure in for a day.
    if results.is_empty() {
        return;
    }
    let entry = CacheEntry { query: key.query.to_string(), provider: key.provider.to_string(), depth: key.depth.to_string(), max_results: key.max_results, created_at: now, results: results.to_vec() };
    if serde_json::to_vec(&entry).is_ok_and(|json| write_atomic(&dir.join(file_name(key)), &json).is_ok()) {
        prune(dir);
    }
}

fn entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).collect()
}

/// Drops the oldest entries once the folder grows past the cap.
fn prune(dir: &Path) {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries(dir).iter().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    files.sort();
    for (_, path) in &files[..files.len() - MAX_CACHE_ENTRIES] {
        let _ = std::fs::remove_file(path);
    }
}

/// (entries, bytes) of the cache, for display.
pub fn cache_stats() -> (usize, u64) {
    stats(&cache_dir())
}

fn stats(dir: &Path) -> (usize, u64) {
    let files = entries(dir);
    (files.len(), files.iter().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
}

/// Removes every cached search.
pub fn clear_cache() {
    let _ = std::fs::remove_dir_all(cache_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder for one test. The checks use it directly, so nothing depends on the variable staying put.
    fn fresh(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("apim-test-{}", std::process::id()));
        // SAFETY: every test here sets the same value.
        unsafe { std::env::set_var("APIM_DATA_ROOT", &root) };
        let dir = root.join(name);
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn remaining_credit_math() {
        let mut record = Record { month: "2026-10".into(), questions: 2, providers: BTreeMap::new() };
        for _ in 0..3 {
            add_request(&mut record, "tavily", "advanced");
        }
        add_request(&mut record, "exa", "advanced");
        add_request(&mut record, "mystery", "basic");
        record.providers.entry("tavily".into()).or_default().cached = 2;
        record.providers.insert("linkup".into(), Counts { requests: 1000, cached: 0, usd: 5.0 });

        let s = summarise(&record, 24);
        assert_eq!(s.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["exa", "tavily", "linkup", "serper"]);
        let tavily = &s.providers[1];
        // Advanced depth is billed double at Tavily: three searches are six requests, $0.048 of the $8 allowance.
        assert_eq!((tavily.requests, tavily.cached, tavily.usd, tavily.remaining_usd, tavily.remaining_requests, tavily.exhausted), (6, 2, 0.048, 7.952, 994, false));
        // Exa has no depth split.
        assert_eq!((s.providers[0].requests, s.providers[0].usd, s.providers[0].remaining_requests), (1, 0.007, 1427));
        assert!(s.providers[2].exhausted && s.providers[2].remaining_requests == 0);
        // Serper has no free allowance, so it is never "exhausted".
        assert!(!s.providers[3].exhausted);
        // The unknown provider is stored but not shown, and costs nothing.
        assert_eq!((s.total_requests, s.total_cached, s.questions, s.requests_per_question), (1007, 2, 2, 503.5));
        assert_eq!(s.cache_hit_rate, 2.0 / 1009.0);
        assert_eq!(summarise(&load(Path::new("no-such-file"), "2026-10"), 1).requests_per_question, 0.0);
    }

    #[test]
    fn month_rollover() {
        // 2026-10-08T12:00Z and 2026-12-31T23:00Z.
        assert_eq!((month_of(1_791_460_800_000).as_str(), days_until_reset(1_791_460_800_000)), ("2026-10", 24));
        assert_eq!((month_of(1_798_758_000_000).as_str(), days_until_reset(1_798_758_000_000)), ("2026-12", 1));

        let file = fresh("usage").join("search-usage.json");
        update(&file, |r| {
            add_request(r, "tavily", "basic");
            r.questions += 1;
        });
        let month = month_of(now_ms());
        let saved = load(&file, &month);
        assert_eq!((saved.questions, saved.providers["tavily"].requests), (1, 1));
        // The web app's layout: two-space indent, month first.
        assert!(std::fs::read_to_string(&file).unwrap().starts_with(&format!("{{\n  \"month\": \"{month}\",\n  \"questions\": 1,\n  \"providers\": {{\n    \"tavily\": {{")));
        // Read in a later month, the old counters are gone.
        assert_eq!(load(&file, "2099-01"), Record { month: "2099-01".into(), questions: 0, providers: BTreeMap::new() });
        // A file the web app wrote, whole numbers and all.
        std::fs::write(&file, "{\n  \"month\": \"2026-10\",\n  \"questions\": 3,\n  \"providers\": {\n    \"exa\": {\n      \"requests\": 2,\n      \"cached\": 0,\n      \"usd\": 0\n    }\n  }\n}").unwrap();
        assert_eq!(load(&file, "2026-10").providers["exa"], Counts { requests: 2, cached: 0, usd: 0.0 });
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn cache_round_trip() {
        let dir = fresh("cache");
        let key = CacheKey { query: "  Hello   World ", provider: "tavily", depth: "basic", max_results: 10 };
        // Same hashes as src/lib/search-cache.ts (node:crypto), so the two apps hit each other's entries.
        assert_eq!(file_name(&key), "fbd3e09b3a73fb83f7a024d1a5ac768a.json");
        assert_eq!(file_name(&CacheKey { query: "playwright python version", provider: "exa", depth: "advanced", max_results: 10 }), "980f4fd6c09c2ad76d81cb104ccd519d.json");

        let hit = SearchResult { title: "T".into(), url: "https://a.test/".into(), content: "c".into(), score: Some(0.5), provider: Some("tavily".into()), ..Default::default() };
        put(&dir, &key, &[], 1_000);
        assert_eq!(stats(&dir), (0, 0));
        put(&dir, &key, std::slice::from_ref(&hit), 1_000);
        assert_eq!(std::fs::read_to_string(dir.join(file_name(&key))).unwrap(), "{\"query\":\"  Hello   World \",\"provider\":\"tavily\",\"depth\":\"basic\",\"maxResults\":10,\"createdAt\":1000,\"results\":[{\"title\":\"T\",\"url\":\"https://a.test/\",\"content\":\"c\",\"score\":0.5,\"provider\":\"tavily\"}]}");
        // Case and spacing do not matter; depth and provider do; a day later it has expired.
        assert_eq!(get(&dir, &CacheKey { query: "hello world", ..key }, 1_000 + CACHE_TTL_MS), Some(vec![hit]));
        assert_eq!(get(&dir, &CacheKey { depth: "advanced", ..key }, 2_000), None);
        assert_eq!(get(&dir, &key, 1_001 + CACHE_TTL_MS), None);
        assert_eq!(stats(&dir).0, 1);
        // An entry the web app wrote for Exa: no score, a published date.
        std::fs::write(dir.join(file_name(&key)), "{\"query\":\"q\",\"provider\":\"exa\",\"depth\":\"basic\",\"maxResults\":10,\"createdAt\":5,\"results\":[{\"title\":\"E\",\"url\":\"u\",\"content\":\"c\",\"provider\":\"exa\",\"publishedDate\":\"2026-01-02\"}]}").unwrap();
        let read = get(&dir, &key, 6).unwrap();
        assert_eq!((read[0].score, read[0].published_date.as_deref()), (None, Some("2026-01-02")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
