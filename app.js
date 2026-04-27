(function () {
    var btn    = document.getElementById('search-btn');
    var input  = document.getElementById('search-input');
    var results  = document.getElementById('results');
    var loading  = document.getElementById('results-loading');
    var errorEl  = document.getElementById('results-error');
    var content  = document.getElementById('results-content');

    btn.addEventListener('click', submitSearch);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitSearch();
    });

    // Browse all — load PGC playlist
    var playlist     = document.getElementById('playlist');
    var playlistLoad = document.getElementById('playlist-loading');
    var playlistErr  = document.getElementById('playlist-error');
    var playlistItems = document.getElementById('playlist-items');

    document.querySelector('.browse_all').addEventListener('click', function () {
      if (playlist.style.display === 'block') {
        playlist.style.display = 'none';
        return;
      }
      // Hide any existing results
      results.style.display = 'none';
      content.style.display = 'none';
      document.getElementById('results-embed').src = '';
      playlist.style.display = 'block';
      playlistLoad.style.display = 'block';
      playlistErr.style.display = 'none';
      playlistItems.innerHTML = '';

      fetch('/api/feed/pgc')
        .then(function (r) { return r.json(); })
        .then(function (meetings) {
          playlistLoad.style.display = 'none';
          if (!meetings.length) {
            playlistErr.textContent = 'No meetings found.';
            playlistErr.style.display = 'block';
            return;
          }
          allMeetings = meetings;
          currentPage = 0;
          renderPage(0);
        })
        .catch(function (err) {
          playlistLoad.style.display = 'none';
          playlistErr.textContent = 'Could not load meetings: ' + err.message;
          playlistErr.style.display = 'block';
        });
    });

    var API_BASE = 'https://meeting-watchdog-temp-653sb.ondigitalocean.app';
    var allMeetings = [];
    var currentPage = 0;
    var PAGE_SIZE = 10;

    function renderPage(page) {
      currentPage = page;
      playlistItems.innerHTML = '';

      var start = page * PAGE_SIZE;
      allMeetings.slice(start, start + PAGE_SIZE).forEach(function (m) {
        var card = document.createElement('div');
        card.className = 'playlist__card';
        var thumb = m.thumbnailUrl ? API_BASE + m.thumbnailUrl : '';
        var meta = [m.date, m.duration || fmtDuration(m.durationSeconds)].filter(Boolean).join(' · ');
        card.innerHTML =
          (thumb ? '<img class="playlist__thumb" src="' + thumb + '" alt="" />' : '<div class="playlist__thumb playlist__thumb--empty"></div>') +
          '<div class="playlist__info">' +
            '<p class="playlist__name">' + esc(m.title || 'Untitled') + '</p>' +
            '<p class="playlist__meta">' + esc(meta) + '</p>' +
          '</div>';
        card.addEventListener('click', function () {
          input.value = 'https://princegeorgescountymd.granicus.com/MediaPlayer.php?clip_id=' + m.videoId;
          document.querySelector('.searchbar__select').value = 'Granicus';
          playlist.style.display = 'none';
          submitSearch();
        });
        playlistItems.appendChild(card);
      });

      // Pagination controls
      var totalPages = Math.ceil(allMeetings.length / PAGE_SIZE);
      var pager = document.createElement('div');
      pager.className = 'playlist__pager';

      var prev = document.createElement('button');
      prev.className = 'playlist__page-btn';
      prev.textContent = '← Prev';
      prev.disabled = page === 0;
      prev.addEventListener('click', function () { renderPage(page - 1); window.scrollTo(0, playlist.offsetTop - 20); });

      var info = document.createElement('span');
      info.className = 'playlist__page-info';
      info.textContent = 'Page ' + (page + 1) + ' of ' + totalPages;

      var next = document.createElement('button');
      next.className = 'playlist__page-btn';
      next.textContent = 'Next →';
      next.disabled = page >= totalPages - 1;
      next.addEventListener('click', function () { renderPage(page + 1); window.scrollTo(0, playlist.offsetTop - 20); });

      pager.appendChild(prev);
      pager.appendChild(info);
      pager.appendChild(next);
      playlistItems.appendChild(pager);
    }

    function submitSearch() {
      var url = input.value.trim();
      if (!url) return;
      var source = document.querySelector('.searchbar__select').value.toLowerCase();

      playlist.style.display = 'none';
      results.style.display = 'block';
      loading.style.display = 'block';
      errorEl.style.display = 'none';
      content.style.display = 'none';
      btn.disabled = true;
      btn.style.opacity = '0.6';

      fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, source: source })
      })
        .then(function (resp) {
          return resp.text().then(function (text) {
            if (!text) throw new Error('Empty response from server (status ' + resp.status + ')');
            var data;
            try { data = JSON.parse(text); } catch (e) {
              throw new Error('Server error (' + resp.status + '): ' + text.slice(0, 300));
            }
            if (!resp.ok) throw new Error(data.error || 'Something went wrong');
            return data;
          });
        })
        .then(function (data) {
          populateResults(data);
          loading.style.display = 'none';
          content.style.display = 'block';
        })
        .catch(function (err) {
          loading.style.display = 'none';
          errorEl.textContent = err.message;
          errorEl.style.display = 'block';
        })
        .finally(function () {
          btn.disabled = false;
          btn.style.opacity = '';
        });
    }

    function populateResults(data) {
      var embedEl  = document.getElementById('results-embed');
      var videoEl  = document.getElementById('results-video');
      var videoWrap = embedEl.closest('.results__video-wrap');

      embedEl.src = '';
      videoEl.src = '';

      if (data.streamUrl) {
        // Granicus — use native video element with HLS
        embedEl.style.display = 'none';
        videoEl.style.display = 'block';
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          var hls = new Hls();
          hls.loadSource(data.streamUrl);
          hls.attachMedia(videoEl);
        } else {
          videoEl.src = data.streamUrl; // Safari supports HLS natively
        }
        videoWrap.style.display = 'block';
      } else if (data.embedUrl) {
        // YouTube — use iframe
        videoEl.style.display = 'none';
        embedEl.style.display = 'block';
        embedEl.src = toEmbedUrl(data.embedUrl);
        videoWrap.style.display = 'block';
      } else {
        videoWrap.style.display = 'none';
      }

      // Analysis
      var analysis = data.analysis || {};
      document.getElementById('results-analysis').innerHTML =
        buildAnalysisHTML(analysis.result || analysis);

      // Wire up Full Analysis dropdown
      analysisLoaded = false;
      var analysisDetails = document.getElementById('analysis-details');
      analysisDetails.dataset.analysisId = data.analysisId || '';
      analysisDetails.style.display = data.analysisId ? 'block' : 'none';
      analysisDetails.open = false;
      document.getElementById('results-full-analysis').textContent = '';

      // Transcript
      var segs = ((data.transcript || {}).segments) || [];
      var transcriptWrap = document.querySelector('.results__transcript-wrap');
      if (segs.length > 0) {
        document.getElementById('results-transcript').innerHTML = buildTranscriptHTML(segs);
        transcriptWrap.style.display = 'block';
      } else {
        transcriptWrap.style.display = 'none';
      }
    }

    function toEmbedUrl(url) {
      var yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (yt) return 'https://www.youtube.com/embed/' + yt[1] + '?enablejsapi=1';
      return url;
    }

    function seekTo(seconds) {
      var videoEl = document.getElementById('results-video');
      var embedEl = document.getElementById('results-embed');
      if (videoEl.style.display !== 'none') {
        // Granicus native video
        videoEl.currentTime = seconds;
        videoEl.play();
      } else {
        // YouTube iframe API
        embedEl.contentWindow.postMessage(JSON.stringify({
          event: 'command',
          func: 'seekTo',
          args: [seconds, true]
        }), '*');
      }
    }

    document.getElementById('results-transcript').addEventListener('click', function (e) {
      var t = e.target.closest('.transcript__time');
      if (t) seekTo(parseInt(t.dataset.time, 10));
    });

    var analysisLoaded = false;
    document.getElementById('analysis-details').addEventListener('toggle', function () {
      if (!this.open || analysisLoaded) return;
      var el = document.getElementById('results-full-analysis');
      el.textContent = 'Loading…';
      var analysisId = document.getElementById('analysis-details').dataset.analysisId;
      if (!analysisId) {
        el.textContent = 'No analysis ID available.';
        return;
      }
      fetch('/api/analyses/' + analysisId)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var result = data.result || data;
          el.innerHTML = buildFullAnalysisHTML(result);
          analysisLoaded = true;
        })
        .catch(function () {
          el.textContent = 'Could not load analysis.';
        });
    });

    function buildAnalysisHTML(a) {
      var html = '';
      if (a.meeting_title)
        html += '<h2 class="results__meeting-title">' + esc(a.meeting_title) + '</h2>';
      if (a.governing_body)
        html += '<p class="results__body">' + esc(a.governing_body) + '</p>';
      if (a.meeting_description)
        html += '<p class="results__description">' + esc(a.meeting_description) + '</p>';

      if (a.key_decisions && a.key_decisions.length) {
        html += '<h3 class="results__section-title">Key Decisions</h3><ul class="results__decisions">';
        a.key_decisions.forEach(function (d) {
          html += '<li><strong>' + esc(d.outcome || '') + '</strong> &mdash; ' + esc(d.description || '');
          if (d.vote_tally)
            html += ' <span class="results__vote">(' + esc(d.vote_tally) + ')</span>';
          html += '</li>';
        });
        html += '</ul>';
      }

      return html;
    }

    function buildTranscriptHTML(segs) {
      var html = '';
      var lastTime = -999;
      segs.forEach(function (seg) {
        if (seg.start - lastTime >= 300) {
          html += '<span class="transcript__time" data-time="' + seg.start + '">' + fmt(seg.start) + '</span>';
          lastTime = seg.start;
        }
        html += esc(seg.text) + ' ';
      });
      return html;
    }

    function fmt(s) {
      var m = Math.floor(s / 60), ss = Math.floor(s % 60);
      return m + ':' + (ss < 10 ? '0' : '') + ss;
    }

    function buildFullAnalysisHTML(a) {
      var html = '';

      if (a.meeting_description)
        html += '<p style="margin-bottom:16px;">' + esc(a.meeting_description) + '</p>';

      if (a.attendees && a.attendees.length) {
        html += '<h4 style="font-family:Geist,sans-serif;font-size:15px;font-weight:700;margin:16px 0 6px;">Attendees</h4>';
        html += '<p>' + a.attendees.map(function(x){ return esc(typeof x === 'string' ? x : x.name || JSON.stringify(x)); }).join(', ') + '</p>';
      }

      if (a.topics_discussed && a.topics_discussed.length) {
        html += '<h4 style="font-family:Geist,sans-serif;font-size:15px;font-weight:700;margin:16px 0 6px;">Topics Discussed</h4><ul style="padding-left:20px;">';
        a.topics_discussed.forEach(function(t) { html += '<li>' + esc(typeof t === 'string' ? t : t.topic || JSON.stringify(t)) + '</li>'; });
        html += '</ul>';
      }

      if (a.key_decisions && a.key_decisions.length) {
        html += '<h4 style="font-family:Geist,sans-serif;font-size:15px;font-weight:700;margin:16px 0 6px;">Key Decisions</h4><ul style="padding-left:20px;">';
        a.key_decisions.forEach(function(d) {
          html += '<li><strong>' + esc(d.outcome || '') + '</strong> — ' + esc(d.description || '');
          if (d.vote_tally) html += ' <em>(' + esc(d.vote_tally) + ')</em>';
          html += '</li>';
        });
        html += '</ul>';
      }

      var top = a.most_newsworthy_item || a.most_newsworthy;
      var others = a.secondary_newsworthy_items || a.secondary_items || [];
      if (!others.length && a.newsworthy_items) others = a.newsworthy_items.slice(top ? 0 : 1);

      if (top) {
        html += '<h4 style="font-family:Geist,sans-serif;font-size:15px;font-weight:700;margin:16px 0 6px;">Top Story</h4>';
        html += '<div style="margin-bottom:14px;">';
        html += '<p><strong>' + esc(top.headline || '') + '</strong></p>';
        html += '<p>' + esc(top.summary || '') + '</p>';
        if (top.evidence_excerpt) html += '<p style="color:#888;font-size:13px;font-style:italic;">' + esc(top.evidence_excerpt) + '</p>';
        html += '</div>';
      }

      if (others.length) {
        html += '<h4 style="font-family:Geist,sans-serif;font-size:15px;font-weight:700;margin:16px 0 6px;">Other Stories</h4>';
        others.forEach(function(item) {
          html += '<div style="margin-bottom:14px;">';
          html += '<p><strong>' + esc(item.headline || '') + '</strong></p>';
          html += '<p>' + esc(item.summary || '') + '</p>';
          if (item.evidence_excerpt) html += '<p style="color:#888;font-size:13px;font-style:italic;">' + esc(item.evidence_excerpt) + '</p>';
          html += '</div>';
        });
      }

      return html || '<p>No analysis content available.</p>';
    }

    function fmtDuration(s) {
      if (!s) return '';
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    }

    function esc(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  }());
