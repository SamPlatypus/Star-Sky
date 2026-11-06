// DOM user interface: toolbar, info card, bottom sheets and toasts.
import { RAD } from '../astro/math.js';
import { formatClock, formatDay, formatFull, formatEventTime, formatDistanceKm, formatMag, formatRA, formatDec,
  formatLatLon, compassPoint, describeSpectrum, escapeHtml } from './format.js';

const $ = (sel) => document.querySelector(sel);

export class UI {
  constructor(app) {
    this.app = app;
    this.sheets = ['#sheet-search', '#sheet-time', '#sheet-menu', '#welcome'].map($);
    this.bind();
  }

  bind() {
    const app = this.app;
    app.on('toast', (m) => this.toast(m));
    app.on('mode', () => this.syncModes());
    app.on('settings', () => this.syncSettings());
    app.on('time', (d) => this.syncTime(d));
    app.on('location', () => this.syncLocation());
    app.on('select', (info) => this.showInfo(info));
    app.on('frame', () => this.syncHeading());

    $('#btn-motion').addEventListener('click', () => app.toggleMotion());
    $('#btn-camera').addEventListener('click', () => app.toggleCamera());
    $('#btn-cons').addEventListener('click', () => {
      const on = !app.settings.showConLines;
      app.set('showConLines', on);
      app.set('showConNames', on);
    });
    $('#btn-night').addEventListener('click', () => app.set('night', !app.settings.night));
    $('#btn-search').addEventListener('click', () => this.openSheet('#sheet-search'));
    $('#btn-menu').addEventListener('click', () => this.openSheet('#sheet-menu'));
    $('#btn-when').addEventListener('click', () => this.openSheet('#sheet-time'));
    for (const b of document.querySelectorAll('.sheet-close')) b.addEventListener('click', () => this.closeSheets());

    // Tapping the sky while a sheet is open only closes the sheet.
    $('#stage').addEventListener('pointerdown', (e) => {
      if (this.sheets.some((s) => !s.hidden)) { this.closeSheets(); e.stopPropagation(); }
    }, true);

    // Info card
    $('#info-close').addEventListener('click', () => app.clearSelection());
    $('#info-center').addEventListener('click', () => { if (app.selection) app.centerOn(app.selection); });

    // Search
    const si = $('#search-input');
    si.addEventListener('input', () => this.renderSearch());
    si.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = $('#search-results button'); if (first) first.click(); }
    });

    // Time
    for (const b of document.querySelectorAll('[data-step]')) {
      b.addEventListener('click', () => app.stepTime(+b.dataset.step));
    }
    $('#time-now').addEventListener('click', () => app.setTimeOffset(0));
    $('#time-input').addEventListener('change', (e) => {
      const d = new Date(e.target.value);
      if (!Number.isNaN(d.getTime())) app.setTime(d);
    });

    // Location
    $('#loc-gps').addEventListener('click', () => this.useGps());
    $('#loc-search').addEventListener('input', () => this.renderCities());
    $('#loc-apply').addEventListener('click', () => {
      const lat = parseFloat($('#loc-lat').value), lon = parseFloat($('#loc-lon').value);
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) { this.toast('Latitude −90…90, longitude −180…180'); return; }
      app.setLocation({ lat, lon, name: formatLatLon(lat, lon), source: 'manual' });
      this.toast('Location set');
    });

    // Settings
    for (const input of document.querySelectorAll('[data-setting]')) {
      input.addEventListener('change', () => app.set(input.dataset.setting, input.checked));
    }
    $('#mag-limit').addEventListener('input', (e) => app.set('magLimit', +e.target.value));
    $('#cam-fov').addEventListener('input', (e) => app.set('cameraFov', +e.target.value));
    $('#menu-calibrate').addEventListener('click', async () => {
      this.closeSheets();
      if (app.mode !== 'sensor') {
        const ok = await app.startSensors();
        if (!ok) return;
      }
      app.startCalibration();
    });
    $('#menu-time').addEventListener('click', () => this.openSheet('#sheet-time'));

    // Calibration banner
    $('#calib-north').addEventListener('click', () => {
      if (app.setNorthHere()) this.toast('North set'); else this.toast('Waiting for sensor data…');
    });
    $('#calib-reset').addEventListener('click', () => { app.set('calibration', 0); this.toast('Calibration reset'); });
    $('#calib-done').addEventListener('click', () => app.endCalibration());

    // Welcome
    $('#welcome-gps').addEventListener('click', async () => { await this.useGps(); this.finishWelcome(); });
    $('#welcome-city').addEventListener('click', () => { this.finishWelcome(); this.openSheet('#sheet-time'); $('#loc-search').focus(); });
    $('#welcome-ok').addEventListener('click', () => this.finishWelcome());
  }

  start() {
    this.syncSettings();
    this.syncModes();
    this.syncTime(this.app.now);
    this.syncLocation();
    if (!this.app.settings.onboarded) {
      $('#welcome-place').textContent = this.app.settings.location.name;
      this.openSheet('#welcome');
    }
  }

  finishWelcome() {
    this.app.settings.onboarded = true;
    this.app.saveSettings();
    this.closeSheets();
  }

  openSheet(sel) {
    const el = $(sel);
    const wasOpen = !el.hidden;
    this.closeSheets();
    if (wasOpen) return;
    el.hidden = false;
    if (sel === '#sheet-search') { this.renderSearch(); setTimeout(() => $('#search-input').focus(), 50); }
    if (sel === '#sheet-time') { this.syncTime(this.app.now); this.syncLocation(); this.renderCities(); }
    $('#info').hidden = true;
  }

  closeSheets() {
    for (const s of this.sheets) s.hidden = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (this.app.selection) $('#info').hidden = false;
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  syncModes() {
    const app = this.app;
    $('#btn-motion').setAttribute('aria-pressed', String(app.mode === 'sensor'));
    $('#btn-camera').setAttribute('aria-pressed', String(app.cameraOn));
    $('#calib-banner').hidden = !(app.calibrating && app.mode === 'sensor');
    $('#heading-readout').hidden = app.mode !== 'sensor';
    $('#info-center').textContent = app.mode === 'sensor' ? 'Follow the arrow' : 'Show me';
    $('#info-center').disabled = app.mode === 'sensor';
  }

  syncSettings() {
    const s = this.app.settings;
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!s[input.dataset.setting];
    $('#mag-limit').value = s.magLimit;
    $('#mag-out').textContent = s.magLimit.toFixed(1);
    $('#cam-fov').value = s.cameraFov;
    $('#camfov-out').textContent = `${Math.round(s.cameraFov)}°`;
    $('#btn-cons').setAttribute('aria-pressed', String(s.showConLines));
    $('#btn-night').setAttribute('aria-pressed', String(s.night));
    document.documentElement.classList.toggle('night', !!s.night);
  }

  syncTime(date) {
    const app = this.app;
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    $('#when-time').textContent = sameDay ? formatClock(date) : `${formatDay(date)} ${formatClock(date)}`;
    $('#btn-when').classList.toggle('offset', !app.isLive);
    if (!$('#sheet-time').hidden) {
      $('#time-full').textContent = `${formatFull(date)}${app.isLive ? ' · live' : ''}`;
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      if (document.activeElement !== $('#time-input')) $('#time-input').value = local.toISOString().slice(0, 16);
    }
  }

  syncLocation() {
    const l = this.app.settings.location;
    if (!l) return;
    $('#when-place').textContent = l.name;
    $('#loc-current').innerHTML = `<strong>${escapeHtml(l.name)}</strong> <span class="muted">${formatLatLon(l.lat, l.lon)}${l.source === 'timezone' ? ' · from time zone' : ''}</span>`;
    $('#loc-lat').value = l.lat;
    $('#loc-lon').value = l.lon;
  }

  syncHeading() {
    if (this.app.mode !== 'sensor') return;
    const now = performance.now();
    if (now - (this.lastHeading || 0) < 120) return;
    this.lastHeading = now;
    const { az, alt } = this.app.view.centerAltAz();
    $('#heading-readout').textContent = `${Math.round(az * RAD) % 360}° ${compassPoint(az)} · ${Math.round(alt * RAD)}°`;
  }

  async useGps() {
    this.toast('Finding your location…');
    const r = await this.app.useDeviceLocation();
    if (r.ok) this.toast(`Location: ${this.app.settings.location.name}`);
    else this.toast(r.reason === 'denied' ? 'Location permission denied — choose a city instead.' : 'Location unavailable — choose a city instead.');
  }

  async renderCities() {
    const q = $('#loc-search').value.trim();
    const ul = $('#loc-results');
    if (!q) { ul.innerHTML = ''; return; }
    const { cities } = await this.app.loadPlaces();
    const norm = this.app.normalizeQuery;
    const nq = norm(q);
    const hits = [];
    for (const c of cities) {
      const n = norm(c[0]);
      if (n.startsWith(nq) || (nq.length > 2 && n.includes(nq)) || (nq.length > 2 && norm(c[1]).startsWith(nq))) hits.push(c);
      if (hits.length >= 12) break;
    }
    ul.innerHTML = hits.map((c, i) => `<li><button data-i="${i}"><span><span class="t">${escapeHtml(c[0])}</span> <span class="s">${escapeHtml(c[1])}</span></span><span class="r">${formatLatLon(c[2], c[3])}</span></button></li>`).join('')
      || '<li class="muted small">No match. You can enter coordinates below.</li>';
    for (const b of ul.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const c = hits[+b.dataset.i];
        this.app.setLocation({ lat: c[2], lon: c[3], name: c[0], source: 'city' });
        $('#loc-search').value = '';
        ul.innerHTML = '';
        this.toast(`Location: ${c[0]}`);
      });
    }
  }

  renderSearch() {
    const results = this.app.search($('#search-input').value);
    const ul = $('#search-results');
    ul.innerHTML = results.map((e, i) => {
      const alt = this.app.altitudeOf(e.item) * RAD;
      const where = alt >= 0 ? `${Math.round(alt)}° up` : 'below horizon';
      return `<li><button data-i="${i}"><span><span class="t">${escapeHtml(e.name)}</span><br><span class="s">${escapeHtml(e.sub)}</span></span><span class="r">${where}</span></button></li>`;
    }).join('') || '<li class="muted small">Nothing found</li>';
    for (const b of ul.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const e = results[+b.dataset.i];
        $('#search-input').value = '';
        this.closeSheets();
        this.app.centerOn(e.item);
      });
    }
  }

  showInfo(info) {
    const card = $('#info');
    if (!info) { card.hidden = true; return; }
    const app = this.app, cons = app.cons;
    const rows = [];
    const conName = (c) => (c >= 0 ? cons.name[c] : '');
    let sub = '';
    if (info.kind === 'star') {
      sub = `${info.hasName ? info.designation + ' · ' : ''}Star in ${conName(info.con)}`;
    } else if (info.kind === 'planet') {
      sub = `Planet in ${conName(info.con)}`;
    } else if (info.kind === 'moon') {
      sub = `${info.phaseName} in ${conName(info.con)}`;
    } else if (info.item.type === 'body' && info.item.id === 'sun') {
      sub = `Our star, in ${conName(info.con)}`;
    } else if (info.kind === 'constellation') {
      sub = `Constellation · ${info.meaning}`;
    }
    if (info.mag !== undefined) rows.push(['Magnitude', formatMag(info.mag)]);
    const altText = `${Math.round(info.alt * RAD)}°${info.below ? ' (below horizon)' : ''}`;
    rows.push(['Altitude', altText]);
    rows.push(['Direction', `${compassPoint(info.az)} · ${Math.round(info.az * RAD) % 360}°`]);
    const rs = info.riseSet;
    if (rs) {
      const ref = app.now;
      if (rs.state === 'up') rows.push(['Rise / set', 'Above the horizon all day']);
      else if (rs.state === 'down') rows.push(['Rise / set', 'Stays below the horizon today']);
      else {
        const ev = [];
        if (rs.rise) ev.push([rs.rise, `Rises ${formatEventTime(rs.rise, ref)}`]);
        if (rs.set) ev.push([rs.set, `Sets ${formatEventTime(rs.set, ref)}`]);
        ev.sort((a, b) => a[0] - b[0]);
        rows.push(['Rise / set', ev.map((e) => e[1]).join(' · ') || '—']);
      }
      if (rs.transit && rs.transitAlt > 0) rows.push(['Highest', `${formatEventTime(rs.transit, ref)} at ${Math.round(rs.transitAlt * RAD)}°`]);
    }
    if (info.kind === 'moon') rows.push(['Illuminated', `${Math.round(info.phase * 100)}%`]);
    else if (info.kind === 'planet' && info.phase < 0.985) rows.push(['Illuminated', `${Math.round(info.phase * 100)}%`]);
    if (info.distKm) rows.push(['Distance', formatDistanceKm(info.distKm)]);
    if (info.diameter) {
      const arcsec = info.diameter * RAD * 3600;
      rows.push(['Apparent size', arcsec > 120 ? `${(arcsec / 60).toFixed(1)}′` : `${arcsec.toFixed(1)}″`]);
    }
    if (info.kind === 'star') {
      if (info.sp) rows.push(['Type', `${describeSpectrum(info.sp) || 'Star'} (${info.sp})`]);
      rows.push(['Catalogue', `HR ${info.hr}`]);
    }
    if (info.radec) rows.push(['RA / Dec', `${formatRA(info.radec.ra)} · ${formatDec(info.radec.dec)}`]);
    if (info.kind === 'constellation') {
      rows.push(['Abbreviation', `${info.abbr} (${info.gen})`]);
      if (info.brightest) rows.push(['Brightest star', info.brightest]);
    }
    $('#info-title').textContent = info.name;
    $('#info-sub').textContent = sub;
    $('#info-rows').innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    const anySheet = this.sheets.some((s) => !s.hidden);
    card.hidden = anySheet;
  }
}
