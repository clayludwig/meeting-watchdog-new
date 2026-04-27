from flask import Flask, request, jsonify, send_from_directory
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta
import requests
import time
import os
import re

EST = timezone(timedelta(hours=-5))

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
API_BASE = "https://meeting-watchdog-temp-653sb.ondigitalocean.app"


@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<string:filename>')
def static_files(filename):
    return send_from_directory(BASE_DIR, filename)


@app.route('/assets/<path:filename>')
def serve_assets(filename):
    return send_from_directory(os.path.join(BASE_DIR, 'assets'), filename)


def extract_video_id(url, source):
    if source == 'youtube':
        m = re.search(r'(?:youtube\.com/watch\?v=|youtu\.be/)([a-zA-Z0-9_-]+)', url)
        return m.group(1) if m else None
    if source == 'granicus':
        m = re.search(r'clip_id=(\d+)', url) or re.search(r'/clip/(\d+)', url)
        return m.group(1) if m else None
    return None


def normalize_granicus_url(url):
    """Ensure Granicus URL has ?clip_id=ID format the API expects."""
    # Already in the correct format
    if 'clip_id=' in url:
        return url
    # Convert path-based formats: /player/clip/ID or /clip/ID
    clip_m = re.search(r'/(?:player/)?clip/(\d+)', url)
    if clip_m:
        domain_m = re.match(r'(https?://[^/]+)', url)
        base = domain_m.group(1) if domain_m else ''
        return f"{base}/MediaPlayer.php?clip_id={clip_m.group(1)}"
    return url


def fetch_from_feed(source, subdomain, video_id):
    meeting_resp = requests.get(
        f"{API_BASE}/v1/feed/{source}/{subdomain}/{video_id}", timeout=30)
    analysis_resp = requests.get(
        f"{API_BASE}/v1/feed/{source}/{subdomain}/{video_id}/analysis", timeout=30)
    meeting = meeting_resp.json() if meeting_resp.ok else {}
    analysis = analysis_resp.json() if analysis_resp.ok else {}
    metadata = meeting.get('metadata', {})
    transcript = meeting.get('transcript', {})
    return jsonify({
        'embedUrl': metadata.get('embedUrl'),
        'streamUrl': metadata.get('streamUrl'),
        'title': metadata.get('displayTitle') or metadata.get('title'),
        'transcript': transcript,
        'analysis': analysis,
        'analysisId': analysis.get('analysisId'),
    })


def find_in_recent_feed(video_id, source):
    """Search /v1/feed/recent for a matching videoId+source, return subdomain if found."""
    feed_resp = requests.get(f"{API_BASE}/v1/feed/recent", timeout=15)
    if not feed_resp.ok:
        return None
    data = feed_resp.json()
    meetings = data.get('meetings') if isinstance(data, dict) else data
    for meeting in meetings:
        if str(meeting.get('videoId')) == str(video_id) and meeting.get('source') == source:
            return meeting.get('subdomain')
    return None


@app.route('/api/analyses/<analysis_id>')
def get_analysis(analysis_id):
    resp = requests.get(f"{API_BASE}/v1/analyses/{analysis_id}", timeout=15)
    if not resp.ok:
        return jsonify({'error': 'Could not fetch analysis'}), resp.status_code
    return jsonify(resp.json())


@app.route('/api/feed/pgc')
def pgc_feed():
    # Scrape all meetings from the Granicus public page
    page = requests.get(
        'https://princegeorgescountymd.granicus.com/ViewPublisher.php?view_id=2',
        timeout=15
    )
    if not page.ok:
        return jsonify({'error': 'Could not fetch Granicus page'}), 502

    soup = BeautifulSoup(page.text, 'html.parser')
    # Page has two listingTables: [0] upcoming events, [1] archived videos
    tables = soup.find_all('table', class_='listingTable')
    table = tables[1] if len(tables) > 1 else (tables[0] if tables else None)
    if not table:
        return jsonify({'error': 'Could not parse meetings page'}), 500

    all_rows = table.find_all('tr')
    print(f"[pgc scrape] found table with {len(all_rows)} rows")

    # Debug: log first row HTML to understand structure
    if all_rows:
        print(f"[pgc scrape] first row HTML: {str(all_rows[0])[:300]}")
    if len(all_rows) > 1:
        print(f"[pgc scrape] second row HTML: {str(all_rows[1])[:300]}")

    meetings = []
    for row in all_rows[1:]:  # skip header row
        cells = row.find_all('td')
        if len(cells) < 3:
            continue

        # Title — first text node before the links
        title_td = cells[0]
        title = title_td.get_text(separator='\n').strip().split('\n')[0].strip()

        # Clip ID — from any link or input containing clip_id=
        clip_id = None
        for a in title_td.find_all('a', href=True):
            m = re.search(r'clip_id=(\d+)', a['href'])
            if m:
                clip_id = m.group(1)
                break
        # Also check the whole row HTML for clip_id
        if not clip_id:
            m = re.search(r'clip_id=(\d+)', str(row))
            if m:
                clip_id = m.group(1)
        if not clip_id:
            continue

        # Date — parse Unix timestamp to EST, fall back to text
        date_text = cells[1].get_text(strip=True)
        ts_match = re.search(r'(\d{9,})', date_text)
        if ts_match:
            dt = datetime.fromtimestamp(int(ts_match.group(1)), tz=EST)
            date = dt.strftime('%b %-d, %Y')
        else:
            date = date_text.strip()

        # Duration — raw string e.g. "02h 58m"
        duration = cells[2].get_text(strip=True)

        meetings.append({
            'title': title,
            'videoId': clip_id,
            'date': date,
            'duration': duration,
            'thumbnailUrl': f"/v1/granicus/thumbnail/princegeorgescountymd/{clip_id}.jpg",
            'processed': False,
        })

    if not meetings:
        return jsonify({'error': f'Scraped {len(all_rows)} rows but found no meetings. First row: {str(all_rows[0])[:200] if all_rows else "none"}'}), 500

    # Mark which meetings already have transcripts
    processed_resp = requests.get(
        f"{API_BASE}/v1/feed/granicus/princegeorgescountymd", timeout=10)
    if processed_resp.ok:
        data = processed_resp.json()
        items = data if isinstance(data, list) else data.get('meetings', [])
        processed_ids = {str(m.get('videoId')) for m in items}
        for m in meetings:
            if m['videoId'] in processed_ids:
                m['processed'] = True

    return jsonify(meetings)


@app.route('/api/process', methods=['POST'])
def process():
    try:
        return _process()
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _process():
    body = request.get_json()
    url = (body or {}).get('url', '').strip()
    source = (body or {}).get('source', '').strip().lower()
    if not url:
        return jsonify({'error': 'URL is required'}), 400

    if source == 'granicus':
        url = normalize_granicus_url(url)

    resp = requests.post(f"{API_BASE}/v1/process", json={'url': url, 'source': source}, timeout=30)

    # If process returns 404, fall back to feed endpoints
    if resp.status_code == 404:
        print(f"[process] 404 — trying feed fallback")
        video_id = extract_video_id(url, source)
        if video_id:
            subdomain = find_in_recent_feed(video_id, source)
            if subdomain:
                print(f"[feed fallback] found {source}/{subdomain}/{video_id}")
                return fetch_from_feed(source, subdomain, video_id)
        return jsonify({'error': 'Meeting not found. It may not have been processed yet.'}), 404

    if not resp.ok:
        return jsonify({'error': f'API returned {resp.status_code}: {resp.text[:200]}'}), 502

    result = resp.json()
    transcript_id = result.get('transcriptId')
    analysis_id = result.get('analysisId')
    print(f"[process] status={result.get('status')} keys={list(result.keys())}")

    # If ready/cached with no inline data, use feed endpoints directly
    if result.get('status') == 'ready' or (not transcript_id and not analysis_id and 'jobId' not in result):
        src = result.get('source')
        subdomain = result.get('subdomain')
        video_id = str(result.get('videoId', '') or '')
        if all([src, subdomain, video_id]):
            print(f"[ready] fetching from feed {src}/{subdomain}/{video_id}")
            return fetch_from_feed(src, subdomain, video_id)
        # Fall back to searching recent feed by URL
        vid = extract_video_id(url, source)
        if vid:
            subdomain = find_in_recent_feed(vid, source)
            if subdomain:
                return fetch_from_feed(source, subdomain, vid)

    # Poll if a transcription job was started
    if 'jobId' in result and result.get('status') not in ('complete', 'completed'):
        job_id = result['jobId']
        for _ in range(150):  # max ~5 minutes
            time.sleep(2)
            job_resp = requests.get(f"{API_BASE}/v1/jobs/{job_id}", timeout=15)
            if not job_resp.ok:
                continue
            job = job_resp.json()
            status = job.get('status', '')
            print(f"[job {job_id}] status={status}")
            if status in ('complete', 'completed', 'done', 'success'):
                job_result = job.get('result') or {}
                print(f"[job complete] result={job_result}")
                transcript_id = job_result.get('transcriptId') or transcript_id
                analysis_id = job_result.get('analysisId') or analysis_id
                break
            if status in ('failed', 'error'):
                # Job failed — try to serve from feed if already processed
                video_id = extract_video_id(url, source)
                if video_id:
                    subdomain = find_in_recent_feed(video_id, source)
                    if subdomain:
                        print(f"[job failed] falling back to feed {source}/{subdomain}/{video_id}")
                        return fetch_from_feed(source, subdomain, video_id)
                return jsonify({'error': "This meeting hasn't been transcribed yet and couldn't be processed. Try a meeting marked 'Transcript ready'."}), 500
        else:
            return jsonify({'error': 'Processing timed out after 5 minutes'}), 504

    # Fetch transcript
    transcript = {}
    metadata = {}
    if transcript_id:
        t_resp = requests.get(f"{API_BASE}/v1/transcripts/{transcript_id}", timeout=30)
        print(f"[transcript {transcript_id}] status={t_resp.status_code}")
        if t_resp.ok:
            t_data = t_resp.json()
            transcript = t_data.get('transcript') or t_data
            metadata = t_data.get('metadata', {})

    # Fetch analysis
    analysis = {}
    if analysis_id:
        a_resp = requests.get(f"{API_BASE}/v1/analyses/{analysis_id}", timeout=30)
        print(f"[analysis {analysis_id}] status={a_resp.status_code}")
        if a_resp.ok:
            analysis = a_resp.json()

    return jsonify({
        'embedUrl': metadata.get('embedUrl') if metadata else None,
        'streamUrl': metadata.get('streamUrl') if metadata else None,
        'title': (metadata.get('displayTitle') or metadata.get('title')) if metadata else None,
        'transcript': transcript,
        'analysis': analysis,
        'analysisId': analysis.get('analysisId') if analysis else None,
    })


if __name__ == '__main__':
    app.run(debug=True, port=5000)
