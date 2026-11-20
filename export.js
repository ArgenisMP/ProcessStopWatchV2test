/* Export module for Process Timer Pro: CSV, Excel (.xlsx), PDF, JSON backup.
   No external libraries — works fully offline. */
(function (root) {
    'use strict';

    const esc = s => String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function includedLaps(session) {
        return (session.laps || []).filter(l => !l.excluded);
    }
    function lapsOf(session) {
        const laps = [...(session.laps || [])].reverse();
        if (laps.length === 0) return [{ lapNum: 1, stepName: 'Total', formattedLap: session.formattedTotalDuration, formattedTotal: session.formattedTotalDuration, lapDurationMs: session.totalDurationMs }];
        return laps;
    }
    function fmt(ms) {
        const t = Math.floor(ms / 1000);
        const p = (n, d = 2) => String(n).padStart(d, '0');
        return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}.${p(Math.floor(ms % 1000), 3)}`;
    }
    function lapStats(session) {
        const inc = includedLaps(session);
        if (inc.length === 0) return { fastest: '-', average: '-', slowest: '-' };
        const d = inc.map(l => l.lapDurationMs);
        const avg = d.reduce((a, b) => a + b, 0) / d.length;
        return { fastest: fmt(Math.min(...d)), average: fmt(avg), slowest: fmt(Math.max(...d)) };
    }

    /* ---------- CSV ---------- */
    function csvCell(v) {
        let s = String(v === undefined || v === null ? '' : v);
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function buildCSV(sessions) {
        const header = ['Process Name', 'Category/Notes', 'Date', 'Total (formatted)', 'Total (ms)', 'Total Laps', 'Included Laps', 'Lap #', 'Step', 'Type', 'Lap Duration', 'Cumulative', 'Lap Duration (ms)', 'Excluded', 'Note'];
        const lines = [header.map(csvCell).join(',')];
        sessions.forEach(s => {
            lapsOf(s).forEach(l => {
                lines.push([
                    s.name, s.category || 'General', s.formattedDate, s.formattedTotalDuration, s.totalDurationMs,
                    (s.laps || []).length, includedLaps(s).length, l.lapNum, l.stepName || '', l.stepType || '',
                    l.formattedLap, l.formattedTotal, l.lapDurationMs, l.excluded ? 'yes' : 'no', l.note || ''
                ].map(csvCell).join(','));
            });
        });
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }
    function buildWideCSV(sessions) {
        const maxLaps = Math.max(...sessions.map(s => (s.laps || []).length), 0);
        const header = ['Process Name', 'Category', 'Date', 'Total (ms)', 'Included laps'];
        for (let i = 1; i <= maxLaps; i++) header.push('Lap ' + i + ' (ms)');
        const lines = [header.map(csvCell).join(',')];
        sessions.forEach(s => {
            const row = [s.name, s.category || 'General', s.formattedDate, s.totalDurationMs, includedLaps(s).length];
            const chrono = [...(s.laps || [])].reverse();
            for (let i = 0; i < maxLaps; i++) row.push(chrono[i] && !chrono[i].excluded ? chrono[i].lapDurationMs : '');
            lines.push(row.map(csvCell).join(','));
        });
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }

    /* ---------- XLSX (hand-built zip) ---------- */
    const enc = new TextEncoder();
    let crcTable = null;
    function crc32(bytes) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcTable[n] = c >>> 0; }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function zipStore(files) {
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const chunks = [], central = []; let offset = 0;
        files.forEach(f => {
            const name = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
            lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
            chunks.push(new Uint8Array(lh.buffer), name, data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
            ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
            ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);
            offset += 30 + name.length + data.length;
        });
        const centralSize = central.reduce((a, c) => a + c.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
        const all = [...chunks, ...central, new Uint8Array(end.buffer)];
        const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
        let pos = 0; all.forEach(c => { out.set(c, pos); pos += c.length; });
        return out;
    }
    function xmlEsc(s) {
        return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function sheetXml(headers, rows, widths) {
        const col = i => String.fromCharCode(65 + i);
        let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
        x += '<row r="1">' + headers.map((h, i) => `<c r="${col(i)}1" t="inlineStr" s="1"><is><t>${xmlEsc(h)}</t></is></c>`).join('') + '</row>';
        rows.forEach((r, ri) => {
            const rn = ri + 2;
            x += `<row r="${rn}">` + r.map((v, i) => {
                if (typeof v === 'number' && isFinite(v)) return `<c r="${col(i)}${rn}"><v>${v}</v></c>`;
                return `<c r="${col(i)}${rn}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v === undefined || v === null ? '' : v)}</t></is></c>`;
            }).join('') + '</row>';
        });
        return x + '</sheetData></worksheet>';
    }
    function buildXLSX(sessions) {
        const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        const sessHeaders = ['Process Name', 'Category', 'Date', 'Total', 'Total (ms)', 'Laps', 'Included', 'Fastest', 'Average', 'Slowest'];
        const sessRows = sessions.map(s => { const st = lapStats(s); return [s.name, s.category || 'General', s.formattedDate, s.formattedTotalDuration, s.totalDurationMs, (s.laps || []).length, includedLaps(s).length, st.fastest, st.average, st.slowest]; });
        const lapHeaders = ['Process Name', 'Category', 'Date', 'Lap #', 'Step', 'Type', 'Duration', 'Cumulative', 'Duration (ms)', 'Excluded'];
        const lapRows = [];
        sessions.forEach(s => lapsOf(s).forEach(l => lapRows.push([s.name, s.category || 'General', s.formattedDate, l.lapNum, l.stepName || '', l.stepType || '', l.formattedLap, l.formattedTotal, l.lapDurationMs, l.excluded ? 'yes' : 'no'])));
        return zipStore([
            { name: '[Content_Types].xml', content:
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
            { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
            { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Sessions" sheetId="1" r:id="rId1"/><sheet name="Laps" sheetId="2" r:id="rId2"/></sheets></workbook>` },
            { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL + '/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>' },
            { name: 'xl/styles.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
            { name: 'xl/worksheets/sheet1.xml', content: sheetXml(sessHeaders, sessRows, [30, 20, 22, 16, 14, 8, 10, 14, 14, 14]) },
            { name: 'xl/worksheets/sheet2.xml', content: sheetXml(lapHeaders, lapRows, [30, 20, 22, 8, 18, 8, 16, 18, 14, 10]) }
        ]);
    }

    /* ---------- PDF ---------- */
    function pdfText(s) {
        const map = { '\u2013': '-', '\u2014': '-', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u2022': '*' };
        let out = '';
        for (const ch of String(s === undefined || s === null ? '' : s)) {
            const c = ch.charCodeAt(0);
            if (map[ch]) out += map[ch];
            else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) out += ch;
            else out += '?';
        }
        return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    }
    function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; }
    function buildPDF(sessions) {
        const W = 595, H = 842, M = 40, ROW = 13;
        const pages = []; let ops, y;
        const text = (font, size, x, yy, str, gray) => ops.push(`BT ${gray !== undefined ? gray + ' g ' : '0 g '}/${font} ${size} Tf ${x} ${yy} Td (${pdfText(str)}) Tj ET`);
        const rule = (yy) => ops.push(`0.8 G 0.5 w ${M} ${yy} m ${W - M} ${yy} l S`);
        function newPage(title) {
            ops = []; pages.push(ops); y = H - M;
            if (title) {
                text('F2', 16, M, y - 12, 'Process Timer Pro - Records');
                text('F1', 9, M, y - 28, 'Generated ' + new Date().toLocaleString(), 0.4);
                y -= 44; rule(y); y -= 16;
            }
        }
        function tableHeader() {
            ops.push(`0.92 g ${M} ${y - 4} ${W - 2 * M} ${ROW + 2} re f`);
            text('F2', 9, M + 6, y, 'Lap'); text('F2', 9, M + 60, y, 'Step');
            text('F2', 9, M + 180, y, 'Duration'); text('F2', 9, M + 300, y, 'Cumulative');
            text('F2', 9, M + 430, y, 'ms'); y -= ROW + 3;
        }
        newPage(true);
        if (sessions.length === 0) text('F1', 11, M, y, 'No records.');
        sessions.forEach(s => {
            const st = lapStats(s);
            if (y < 150) newPage(false);
            text('F2', 12, M, y, clip(s.name, 70)); y -= 14;
            text('F1', 9, M, y, `Category: ${clip(s.category || 'General', 40)}   |   Recorded: ${s.formattedDate}`, 0.35); y -= 13;
            text('F1', 9, M, y, `Total: ${s.formattedTotalDuration}   |   Laps: ${(s.laps || []).length}   |   Fastest: ${st.fastest}   Average: ${st.average}   Slowest: ${st.slowest}`, 0.35); y -= 16;
            tableHeader();
            lapsOf(s).forEach(l => {
                if (y < M + 20) { newPage(false); text('F2', 10, M, y, clip(s.name, 70) + ' (cont.)', 0.35); y -= 16; tableHeader(); }
                text('F3', 9, M + 6, y, String(l.lapNum));
                text('F3', 9, M + 60, y, clip(l.stepName || '', 22));
                text('F3', 9, M + 180, y, l.formattedLap);
                text('F3', 9, M + 300, y, l.formattedTotal);
                text('F3', 9, M + 430, y, String(l.lapDurationMs));
                y -= ROW;
            });
            y -= 14;
        });
        pages.forEach((p, i) => { ops = p; text('F1', 8, W / 2 - 25, 22, `Page ${i + 1} of ${pages.length}`, 0.5); });
        const objs = [];
        objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
        objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
        objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
        objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
        pages.forEach((p, i) => {
            const stream = p.join('\n');
            objs[5 + i * 2 + 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
            objs[5 + i * 2 + 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
        });
        let pdf = '%PDF-1.4\n'; const offsets = [];
        for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
        const xref = pdf.length;
        pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
        for (let i = 1; i < objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
        const bytes = new Uint8Array(pdf.length);
        for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
        return bytes;
    }

    /* ---------- DOWNLOAD + MENUS ---------- */
    function downloadBlob(data, mime, filename) {
        const blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    function exportRecords(format, sessionId) {
        const sessions = sessionId ? savedSessions.filter(s => s.id === sessionId) : savedSessions;
        if (sessions.length === 0) { showToast('No records to export.', 'error'); return; }
        const base = sessionId ? slugify(sessions[0].name) : 'Process_Timing_All_Records';
        const stamp = new Date().toISOString().slice(0, 10);
        const file = `${base}_${stamp}`;
        try {
            if (format === 'csv') downloadBlob(buildCSV(sessions), 'text/csv;charset=utf-8', file + '.csv');
            else if (format === 'widecsv') downloadBlob(buildWideCSV(sessions), 'text/csv;charset=utf-8', file + '_wide.csv');
            else if (format === 'xlsx') downloadBlob(buildXLSX(sessions), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file + '.xlsx');
            else if (format === 'pdf') downloadBlob(buildPDF(sessions), 'application/pdf', file + '.pdf');
            else if (format === 'json') downloadBlob(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sessions }, null, 2), 'application/json', file + '.json');
            showToast(`Exported ${format.toUpperCase()}`, 'success');
        } catch (e) {
            console.error('Export failed', e);
            showToast('Export failed: ' + e.message, 'error');
        }
    }

    function closeExportMenu() {
        const m = document.getElementById('exportMenu');
        if (m) m.remove();
        document.removeEventListener('click', closeExportMenu);
        document.removeEventListener('keydown', onMenuKey);
    }
    function onMenuKey(e) { if (e.key === 'Escape') closeExportMenu(); }
    function openExportMenu(event, sessionId) {
        if (event && event.stopPropagation) event.stopPropagation();
        closeExportMenu();
        const menu = document.createElement('div');
        menu.id = 'exportMenu';
        menu.className = 'fixed z-[70] w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-1 text-xs font-medium text-slate-200';
        const items = [
            ['csv', 'table', 'CSV (long)'],
            ['widecsv', 'table-2', 'CSV (wide: laps × columns)'],
            ['xlsx', 'file-spreadsheet', 'Excel (.xlsx)'],
            ['pdf', 'file-text', 'PDF (.pdf)'],
            ['json', 'file-json', 'JSON (data backup)']
        ];
        menu.innerHTML = items.map(([f, icon, label]) =>
            `<button data-fmt="${f}" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left"><i data-lucide="${icon}" class="w-4 h-4 text-indigo-400"></i>${label}</button>`).join('');
        document.body.appendChild(menu);
        const r = event.currentTarget.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - 216, r.right - 208));
        const top = Math.min(window.innerHeight - 210, r.bottom + 6);
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-fmt]');
            if (!btn) return;
            closeExportMenu();
            exportRecords(btn.dataset.fmt, sessionId);
        });
        if (window.lucide) lucide.createIcons();
        setTimeout(() => {
            document.addEventListener('click', closeExportMenu);
            document.addEventListener('keydown', onMenuKey);
        }, 0);
    }

    /* ---------- BACKUP MENU ---------- */
    function closeBackupMenu() {
        const m = document.getElementById('backupMenu');
        if (m) m.remove();
        document.removeEventListener('click', closeBackupMenu);
        document.removeEventListener('keydown', onBackupKey);
    }
    function onBackupKey(e) { if (e.key === 'Escape') closeBackupMenu(); }
    function openBackupMenu(event) {
        if (event && event.stopPropagation) event.stopPropagation();
        closeBackupMenu();
        const menu = document.createElement('div');
        menu.id = 'backupMenu';
        menu.className = 'fixed z-[70] w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-1 text-xs font-medium text-slate-200';
        menu.innerHTML = `
            <button data-act="backup" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left"><i data-lucide="download" class="w-4 h-4 text-indigo-400"></i>Backup (JSON download)</button>
            <button data-act="restore" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left"><i data-lucide="upload" class="w-4 h-4 text-emerald-400"></i>Restore (JSON file)</button>
            <hr class="my-1 border-slate-700">
            <button data-act="merge" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left"><i data-lucide="git-merge" class="w-4 h-4 text-amber-400"></i>Merge JSON into current</button>`;
        document.body.appendChild(menu);
        const r = event.currentTarget.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(window.innerWidth - 232, r.right - 224)) + 'px';
        menu.style.top = (r.bottom + 6) + 'px';
        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            closeBackupMenu();
            if (act === 'backup') exportRecords('json', null);
            else if (act === 'restore') importJSON(false);
            else if (act === 'merge') importJSON(true);
        });
        if (window.lucide) lucide.createIcons();
        setTimeout(() => {
            document.addEventListener('click', closeBackupMenu);
            document.addEventListener('keydown', onBackupKey);
        }, 0);
    }
    function importJSON(merge) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
            const file = input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const incoming = Array.isArray(data) ? data : (data.sessions || []);
                    if (!Array.isArray(incoming)) throw new Error('Invalid backup format');
                    if (merge) {
                        const existing = new Set(savedSessions.map(s => s.id));
                        let added = 0;
                        incoming.forEach(s => { if (!existing.has(s.id)) { savedSessions.push(migrateRecord(s)); added++; } });
                        saveSessionsToStorage();
                        showToast(`Merged ${added} new records`, 'success');
                    } else {
                        if (!confirm(`Replace ALL current records with ${incoming.length} from this backup? This cannot be undone.`)) return;
                        savedSessions = incoming.map(migrateRecord);
                        saveSessionsToStorage();
                        showToast(`Restored ${savedSessions.length} records`, 'success');
                    }
                    renderSavedRecords();
                    renderRecordsView();
                    refreshStudyAndCompareSelectors();
                    renderStudyView();
                    renderCompareView();
                } catch (e) {
                    console.error(e);
                    showToast('Invalid JSON: ' + e.message, 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    const api = { buildCSV, buildWideCSV, buildXLSX, buildPDF, exportRecords, openExportMenu, openBackupMenu };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);