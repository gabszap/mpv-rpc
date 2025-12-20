"""
Jikan API (MyAnimeList) integration for fetching anime cover images.
Supports season detection through relationship navigation.
"""

import json
import time
import threading
import requests
from pathlib import Path
import re

# Jikan API v4 endpoint
JIKAN_URL = "https://api.jikan.moe/v4"

# Cache paths
CACHE_DIR = Path(__file__).parent / ".anime_cache"
CACHE_FILE = CACHE_DIR / "anime_cache.json"
LOG_FILE = CACHE_DIR / "api_log.txt"

# In-memory cache
_memory_cache: dict = {}
_cache_loaded = False  # Flag to track if cache was loaded

# Threading lock to prevent concurrent API calls and cache access
_api_lock = threading.Lock()

# Global throttle to avoid rate limiting (Jikan allows ~3 req/s, we use 1.5s to be safe)
_last_request_time = 0.0
_MIN_REQUEST_INTERVAL = 0.5  # seconds between API requests


def _log_api_call(endpoint: str, params: dict | None, status: str, result: str):
    """Log API call to file for debugging."""
    CACHE_DIR.mkdir(exist_ok=True)
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {status} | {endpoint} | params={params} | {result}\n"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_line)


def _load_persistent_cache() -> dict:
    """Load cache from JSON file."""
    global _memory_cache, _cache_loaded
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                _memory_cache = json.load(f)
        except (json.JSONDecodeError, IOError):
            _memory_cache = {}
    _cache_loaded = True
    return _memory_cache


def _save_persistent_cache():
    """Save cache to JSON file."""
    CACHE_DIR.mkdir(exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(_memory_cache, f, ensure_ascii=False, indent=2)


def _get_cache_key(title: str, season: int | None) -> str:
    """Generate cache key from title and season."""
    return f"{title.lower().strip()}|{season or 1}"


def _jikan_request(endpoint: str, params: dict = None) -> dict | None:
    """
    Make a request to Jikan API with retry logic and global throttling.
    Jikan has rate limiting of 3 requests/second for normal users.
    """
    global _last_request_time
    
    # Global throttle - ensure minimum interval between requests
    elapsed = time.time() - _last_request_time
    if elapsed < _MIN_REQUEST_INTERVAL:
        time.sleep(_MIN_REQUEST_INTERVAL - elapsed)
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.get(
                f"{JIKAN_URL}/{endpoint}",
                params=params,
                timeout=15
            )
            
            # Handle rate limiting (429)
            if response.status_code == 429:
                wait_time = (attempt + 1) * 3  # 3s, 6s, 9s
                _log_api_call(endpoint, params, "429 RATE_LIMITED", f"waiting {wait_time}s")
                print(f"[anime_lookup] Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
            
            response.raise_for_status()
            _last_request_time = time.time()  # Update throttle timer
            result = response.json()
            
            # Build detailed result info for logging
            data = result.get('data', [])
            if isinstance(data, list):
                # Search results - show titles
                titles = [f"{d.get('mal_id')}: {d.get('title', 'N/A')}" for d in data[:5]]
                result_info = f"{len(data)} results: {titles}"
            elif isinstance(data, dict):
                # Single anime result - show title
                result_info = f"ID={data.get('mal_id')} title={data.get('title', 'N/A')}"
            else:
                result_info = f"{len(data)} results"
            
            _log_api_call(endpoint, params, "200 OK", result_info)
            return result
            
        except requests.RequestException as e:
            _log_api_call(endpoint, params, f"ERROR attempt {attempt+1}", str(e))
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 2
                print(f"[anime_lookup] Retry {attempt + 1}/{max_retries} after {wait_time}s: {e}")
                time.sleep(wait_time)
            else:
                print(f"[anime_lookup] Error after {max_retries} attempts: {e}")
                return None
    return None


def search_anime(title: str) -> dict | None:
    """
    Search for an anime by title on Jikan (MyAnimeList).
    Returns the best match prioritizing title similarity over popularity.
    """
    # Search without type filter to find all anime types (including donghua/ONA)
    result = _jikan_request("anime", {"q": title, "limit": 10})
    
    if result and result.get("data"):
        data = result["data"]
        
        # Score each result based on title similarity and popularity
        def score_result(anime):
            anime_title = anime.get("title", "").lower()
            search_title = title.lower()
            
            # Check if search title is contained in anime title
            contains_search = search_title in anime_title
            
            # Count common words
            search_words = set(search_title.split())
            anime_words = set(anime_title.split())
            common_words = len(search_words & anime_words)
            
            # Prioritize exact/similar matches, then popularity
            # Formula: (contains_bonus * 1000000) + (common_words * 10000) + members
            contains_bonus = 1 if contains_search else 0
            members = anime.get("members", 0)
            
            return (contains_bonus * 1000000) + (common_words * 10000) + members
        
        # Sort by score (higher is better)
        sorted_data = sorted(data, key=score_result, reverse=True)
        return sorted_data[0]
    
    return None


def get_anime_by_id(mal_id: int) -> dict | None:
    """Get anime details by MAL ID."""
    result = _jikan_request(f"anime/{mal_id}")
    if result and result.get("data"):
        return result["data"]
    return None


def get_anime_relations(mal_id: int) -> list:
    """Get anime relations (sequels, prequels, etc.) by MAL ID."""
    result = _jikan_request(f"anime/{mal_id}/relations")
    if result and result.get("data"):
        return result["data"]
    return []


def get_episode_title(anime_title: str, season: int | None, episode: int) -> str | None:
    """
    Get episode title from Jikan API.
    Returns episode title or None if not found.
    """
    with _api_lock:
        # Build cache key
        cache_key = f"ep_title|{anime_title.lower().strip()}|{season or 1}|{episode}"
        
        # Check cache
        global _cache_loaded
        if not _cache_loaded:
            _load_persistent_cache()
        
        if cache_key in _memory_cache:
            return _memory_cache[cache_key]
        
        try:
            # Search for anime
            anime = search_anime(anime_title)
            if not anime:
                return None
            
            # Navigate to correct season if needed
            if season and season > 1:
                anime = _find_season_in_relations(anime, season)
                if not anime:
                    return None
            
            mal_id = anime.get("mal_id")
            if not mal_id:
                return None
            
            # Get episodes list
            episodes_result = _jikan_request(f"anime/{mal_id}/episodes")
            if not episodes_result or not episodes_result.get("data"):
                return None
            
            # Find matching episode by episode number
            episodes = episodes_result["data"]
            for ep in episodes:
                # Jikan episodes have 'mal_id' (episode ID) but we need to match by episode number
                if ep.get("mal_id") == episode:  # mal_id is the episode number in Jikan v4
                    title = ep.get("title")
                    if title:
                        # Cache the result
                        _memory_cache[cache_key] = title
                        _save_persistent_cache()
                        return title
            
            return None
            
        except Exception as e:
            print(f"[anime_lookup] Error getting episode title: {e}")
            return None



def _find_season_in_relations(anime: dict, target_season: int) -> dict | None:
    """
    Navigate through anime relations to find the correct season.
    Walks through SEQUEL chain and matches by season number in title.
    """
    if target_season <= 1:
        return anime
    
    current = anime
    visited_ids = {anime.get("mal_id")}
    all_seasons = [anime]  # Store all seasons found
    max_hops = 20
    
    for _ in range(max_hops):
        # Get relations for current anime
        relations = get_anime_relations(current.get("mal_id"))
        
        # Wait between requests to avoid rate limiting
        time.sleep(0.5)
        
        # Find sequel
        sequel = None
        for relation_group in relations:
            if relation_group.get("relation") == "Sequel":
                for entry in relation_group.get("entry", []):
                    if entry.get("mal_id") not in visited_ids:
                        sequel = entry
                        break
                if sequel:
                    break
        
        if not sequel:
            break
        
        visited_ids.add(sequel.get("mal_id"))
        
        # Get full data for sequel
        sequel_data = get_anime_by_id(sequel.get("mal_id"))
        
        # Wait between requests
        time.sleep(0.5)
        
        if sequel_data:
            current = sequel_data
            # Add to all_seasons regardless of type (to continue chain through movies)
            all_seasons.append(current)
        else:
            current = sequel
            all_seasons.append(current)
    
    # Now find TV anime matching target_season by title  
    for season_anime in all_seasons:
        # Only match TV series
        if season_anime.get("type") != "TV":
            continue
            
        season_title = season_anime.get("title", "")
        season_num = _extract_season_number(season_title)
        if season_num == target_season:
            return season_anime
    
    # Fallback: return last TV in chain
    for season_anime in reversed(all_seasons):
        if season_anime.get("type") == "TV":
            return season_anime
    
    return current

def _extract_season_number(title: str) -> int:
    """
    Extract season number from anime title.
    Examples:
    - "Re:Zero 2nd Season" -> 2
    - "Re:Zero 3rd Season" -> 3
    - "Re:Zero 2nd Season Part 2" -> 2 (Part is ignored)
    """
    
    # Try to match "Xnd Season", "Xrd Season", "Xth Season", etc.
    match = re.search(r'(\d+)(?:st|nd|rd|th)\s+Season', title, re.IGNORECASE)
    if match:
        return int(match.group(1))
    
    # Default to season 1
    return 1



def get_anime_cover(title: str, season: int | None = None) -> str | None:
    """
    Get the cover image URL for an anime.
    If season is specified, attempts to find that specific season's cover.
    """
    # Use lock to prevent concurrent API calls for the same anime
    with _api_lock:
        # Load persistent cache only once
        global _cache_loaded
        if not _cache_loaded:
            _load_persistent_cache()
        
        cache_key = _get_cache_key(title, season)
        
        # Check cache
        if cache_key in _memory_cache:
            return _memory_cache[cache_key]
    
        # Use search_anime which has the improved scoring system
        anime = search_anime(title)
        if not anime:
            return None
        
        # Navigate to correct season if needed
        if season and season > 1:
            anime = _find_season_in_relations(anime, season)
        
        # Get cover image
        images = anime.get("images", {}).get("jpg", {})
        cover_url = images.get("large_image_url") or images.get("image_url")
        
        if cover_url:
            _memory_cache[cache_key] = cover_url
            _save_persistent_cache()
        
        return cover_url


def get_anime_info(title: str, season: int | None = None) -> dict:
    """
    Get complete anime info including cover and titles.
    """
    with _api_lock:
        global _cache_loaded
        if not _cache_loaded:
            _load_persistent_cache()
        
        info_key = f"info|{_get_cache_key(title, season)}"
        
        if info_key in _memory_cache:
            return _memory_cache[info_key]
        
        anime = None
        
        # Try season-specific search first for EARLY EXIT
        if season and season > 1:
            season_search = search_anime(f"{title} Season {season}")
            if season_search:
                # Check if result contains target season number in title
                result_season = _extract_season_number(season_search.get("title", ""))
                result_title = season_search.get("title", "").lower()
                
                # Verify title similarity to avoid wrong matches (e.g. Attack on Titan for Bunny Girl)
                title_lower = title.lower()
                # Extract base words from both titles for comparison
                title_words = set(title_lower.split())
                result_words = set(result_title.split())
                common_words = title_words & result_words
                
                # If season matches AND has significant title overlap, use it immediately (EARLY EXIT)
                if result_season == season and len(common_words) >= 2:
                    anime = season_search
        
        # Fallback: base search + relation navigation
        if not anime:
            anime = search_anime(title)
            if not anime:
                return {"cover_url": None, "title_romaji": None, "title_english": None}
            
            if season and season > 1:
                anime = _find_season_in_relations(anime, season)
        
        images = anime.get("images", {}).get("jpg", {})
        titles = anime.get("titles", [])
        
        # Extract titles
        title_english = anime.get("title_english")
        title_romaji = anime.get("title")  # default title in Jikan is usually romaji
        
        result = {
            "cover_url": images.get("large_image_url") or images.get("image_url"),
            "title_romaji": title_romaji,
            "title_english": title_english,
            "mal_id": anime.get("mal_id")
        }
        
        _memory_cache[info_key] = result
        _save_persistent_cache()
        
        return result


if __name__ == "__main__":
    # Test the module
    test_cases = [
        ("Rascal Does Not Dream of Bunny Girl Senpai", 1),
        ("Rascal Does Not Dream of Bunny Girl Senpai", 2),
        ("Attack on Titan", 4),
    ]
    
    for title, season in test_cases:
        print(f"\n=== Testing: {title} S{season:02d} ===")
        info = get_anime_info(title, season)
        print(f"Title: {info.get('title_english') or info.get('title_romaji')}")
        print(f"MAL ID: {info.get('mal_id')}")
        print(f"Cover: {info.get('cover_url')}")
        time.sleep(1)  # Wait between tests
