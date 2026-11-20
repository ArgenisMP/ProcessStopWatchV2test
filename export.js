/* Export module for Process Timer Pro: CSV, Excel (.xlsx), PDF, JSON backup.
   No external libraries — works fully offline. */
(function (root) {
    'use strict';

    function fmt(ms) {
        const t = Math.floor(Math.max(0, ms) / 1000);
        const p = (n, d = 2) => String(n).padStart(d, '0');
        return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}.${p(Math.floor(Math.max(0, ms) % 1000), 3)}`;
    }
    function includedLaps(session) {
        return (session.laps || []).filter(l => !l.excluded);
    }
    function chronoLaps(session) {
        return [...(session.laps || [])].reverse();
    }
    function computeStats(session) {
        const allLaps = session.laps || [];
        const total = session.totalDurationMs || 0;
        const stepsPerCycle = session.template && Array.isArray(session.template.steps) ? session.template.steps.length : 0;
        const hasCycleTags = allLaps.some(l => l.cycleNum != null);

        if (stepsPerCycle > 0 && hasCycleTags) {
            const byCycle = new Map();
            allLaps.forEach(l => {
                if (l.cycleNum == null) return;
                if (!byCycle.has(l.cycleNum)) byCycle.set(l.cycleNum, []);
                byCycle.get(l.cycleNum).push(l);
            });
            const validCycles = [];
            let excludedCycles = 0;
            byCycle.forEach(group => {
                if (group.length < stepsPerCycle) return;
                if (group.some(l => l.excluded)) { excludedCycles++; return; }
                validCycles.push(group.reduce((s, l) => s + (l.lapDurationMs || 0), 0));
            });
            if (validCycles.length > 0) {
                const n = validCycles.length;
                const avg = validCycles.reduce((a, b) => a + b, 0) / n;
                const variance = n > 1 ? validCycles.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1) : 0;
                const std = Math.sqrt(variance);
                return { mode: 'cycles', n, excludedN: excludedCycles, avg, min: Math.min(...validCycles), max: Math.max(...validCycles), std, cv: avg > 0 ? (std / avg) * 100 : 0, basisIsTotal: false };
            }
        }

        const inc = includedLaps(session);
        const d = inc.map(l => l.lapDurationMs);
        if (d.length === 0) {
            return { mode: 'laps', n: 0, excludedN: allLaps.length, avg: total, min: total, max: total, std: 0, cv: 0, basisIsTotal: true };
        }
        const n = d.length;
        const avg = d.reduce((a, b) => a + b, 0) / n;
        const variance = n > 1 ? d.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1) : 0;
        const std = Math.sqrt(variance);
        return { mode: 'laps', n, excludedN: allLaps.length - n, avg, min: Math.min(...d), max: Math.max(...d), std, cv: avg > 0 ? (std / avg) * 100 : 0, basisIsTotal: false };
    }
    function getEstimator(session) {
        return Object.assign({ ttdH: 8, ttdM: 0, performancePct: 100, allowancePct: 10, demandUnits: 0 }, session.estimator || {});
    }
    function estimatorValues(session) {
        const est = getEstimator(session);
        const st = computeStats(session);
        const totalMin = (est.ttdH || 0) * 60 + (est.ttdM || 0);
        const availMs = totalMin * 60000;
        const rating = (est.performancePct || 100) / 100;
        const allowanceMult = 1 + ((est.allowancePct || 0) / 100);
        const demandUnits = est.demandUnits || 0;

        const normalMs = (st.avg || 0) * rating;
        const standardMs = normalMs * allowanceMult;
        const bestStdMs = (st.min || 0) * rating * allowanceMult;
        const worstStdMs = (st.max || 0) * rating * allowanceMult;
        const taktMs = (demandUnits > 0 && availMs > 0) ? (availMs / demandUnits) : null;

        return {
            ttdH: est.ttdH || 0,
            ttdM: est.ttdM || 0,
            performancePct: est.performancePct || 100,
            allowancePct: est.allowancePct || 0,
            demandUnits,
            availLabel: `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`,
            availMs,
            normalMs,
            standardMs,
            taktMs,
            perHour: standardMs > 0 ? 3600000 / standardMs : null,
            perTTD: (standardMs > 0 && availMs > 0) ? Math.floor(availMs / standardMs) : null,
            bestHour: bestStdMs > 0 ? 3600000 / bestStdMs : null,
            bestTTD: (bestStdMs > 0 && availMs > 0) ? Math.floor(availMs / bestStdMs) : null,
            worstHour: worstStdMs > 0 ? 3600000 / worstStdMs : null,
            worstTTD: (worstStdMs > 0 && availMs > 0) ? Math.floor(availMs / worstStdMs) : null
        };
    }

    /* ---------- CSV ---------- */
    function csvCell(v) {
        let s = String(v === undefined || v === null ? '' : v);
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function buildCSV(sessions) {
        const header = [
            'Process Name', 'Category/Notes', 'Date', 'Total (formatted)', 'Total (ms)',
            'Total Laps', 'Included Units', 'Excluded Units',
            'Fastest', 'Average (OT)', 'Slowest', 'Std Dev (ms)', 'CV (%)',
            'Rating %', 'Allowance %', 'Normal Time (ms)', 'Standard Time (ms)',
            'TTD (h)', 'TTD (m)', 'Demand (pcs)', 'Takt Time (ms)',
            'Std Pieces/Hour', 'Std Pieces in TTD',
            'Best Std Pieces/Hour', 'Best Std Pieces in TTD', 'Worst Std Pieces/Hour', 'Worst Std Pieces in TTD',
            'Lap #', 'Cycle #', 'Step', 'Type', 'Lap Duration', 'Cumulative', 'Lap Duration (ms)',
            'Vs Average (ms)', 'Excluded', 'Note'
        ];
        const lines = [header.map(csvCell).join(',')];
        sessions.forEach(s => {
            const st = computeStats(s);
            const ev = estimatorValues(s);
            const chrono = chronoLaps(s);
            chrono.forEach(l => {
                const diff = (l.lapDurationMs - st.avg);
                lines.push([
                    s.name, s.category || 'General', s.formattedDate, s.formattedTotalDuration, s.totalDurationMs,
                    (s.laps || []).length, st.n, st.excludedN,
                    fmt(st.min), fmt(st.avg), fmt(st.max), st.std.toFixed(0), st.cv.toFixed(2),
                    ev.performancePct, ev.allowancePct, Math.round(ev.normalMs), Math.round(ev.standardMs),
                    ev.ttdH, ev.ttdM, ev.demandUnits, ev.taktMs != null ? Math.round(ev.taktMs) : '',
                    ev.perHour != null ? ev.perHour.toFixed(2) : '',
                    ev.perTTD != null ? ev.perTTD : '',
                    ev.bestHour != null ? ev.bestHour.toFixed(2) : '',
                    ev.bestTTD != null ? ev.bestTTD : '',
                    ev.worstHour != null ? ev.worstHour.toFixed(2) : '',
                    ev.worstTTD != null ? ev.worstTTD : '',
                    l.lapNum, l.cycleNum != null ? l.cycleNum : '', l.stepName || '', l.stepType || '',
                    l.formattedLap, l.formattedTotal, l.lapDurationMs,
                    (isFinite(diff) ? diff.toFixed(0) : ''), l.excluded ? 'yes' : 'no', l.note || ''
                ].map(csvCell).join(','));
            });
        });
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }
    function buildWideCSV(sessions) {
        const maxLaps = Math.max(...sessions.map(s => (s.laps || []).length), 0);
        const header = [
            'Process Name', 'Category', 'Date', 'Total (ms)', 'Included Units',
            'Fastest', 'Average (OT)', 'Slowest', 'CV (%)',
            'Rating %', 'Allowance %', 'Standard Time (ms)', 'Takt Time (ms)',
            'TTD (h)', 'TTD (m)', 'Std Pieces/Hour', 'Std Pieces in TTD'
        ];
        for (let i = 1; i <= maxLaps; i++) header.push(`Lap ${i} (ms)`);
        const lines = [header.map(csvCell).join(',')];
        sessions.forEach(s => {
            const st = computeStats(s);
            const ev = estimatorValues(s);
            const row = [
                s.name, s.category || 'General', s.formattedDate, s.totalDurationMs, st.n,
                fmt(st.min), fmt(st.avg), fmt(st.max), st.cv.toFixed(2),
                ev.performancePct, ev.allowancePct, Math.round(ev.standardMs),
                ev.taktMs != null ? Math.round(ev.taktMs) : '',
                ev.ttdH, ev.ttdM,
                ev.perHour != null ? ev.perHour.toFixed(2) : '',
                ev.perTTD != null ? ev.perTTD : ''
            ];
            const chrono = chronoLaps(s);
            for (let i = 0; i < maxLaps; i++) row.push(chrono[i] && !chrono[i].excluded ? chrono[i].lapDurationMs : '');
            lines.push(row.map(csvCell).join(','));
        });
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }

    /* ---------- XLSX ---------- */
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
        const col = i => {
            let s = '', n = i + 1;
            while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
            return s;
        };
        let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
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

    function reportSheetXml(sessions) {
        const col = i => String.fromCharCode(65 + i);
        const rows = [];
        const breaks = [];
        let r = 1;
        const add = (cells) => { rows.push({ r: r++, cells }); };
        const gap = (n = 1) => { r += n; };

        add([{ v: 'Process Timer Pro - Records', s: 2 }]);
        add([{ v: 'Generated ' + new Date().toLocaleString(), s: 4 }]);
        gap();

        if (sessions.length === 0) add([{ v: 'No records.', s: 0 }]);

        sessions.forEach((s, si) => {
            const st = computeStats(s);
            const ev = estimatorValues(s);
            add([{ v: s.name, s: 3 }]);
            add([{ v: `Category: ${s.category || 'General'}   |   Recorded: ${s.formattedDate}`, s: 4 }]);
            add([{ v: `Total: ${s.formattedTotalDuration}   |   Laps: ${(s.laps || []).length} (included ${st.n} ${st.mode}, excluded ${st.excludedN})`, s: 4 }]);
            add([{ v: `Fastest: ${fmt(st.min)}   Average (OT): ${fmt(st.avg)}   Slowest: ${fmt(st.max)}   Std Dev: ${(st.std / 1000).toFixed(3)} s   CV: ${st.cv.toFixed(1)}%`, s: 4 }]);
            add([{ v: `Rating: ${ev.performancePct}%   Allowance: ${ev.allowancePct}%   Normal Time: ${fmt(ev.normalMs)}   Standard Time: ${fmt(ev.standardMs)}   Takt: ${ev.taktMs != null ? fmt(ev.taktMs) : '--'}`, s: 4 }]);
            add([{ v: `TTD: ${ev.availLabel}   →   ${ev.perHour != null ? ev.perHour.toFixed(1) : '--'} std pcs/h   |   ${ev.perTTD != null ? ev.perTTD : '--'} std pcs in TTD`, s: 4 }]);
            add(['Lap', 'Cycle', 'Step', 'Type', 'Duration', 'Cumulative', 'Duration (ms)', 'Excluded', 'Note'].map(h => ({ v: h, s: 5 })));
            chronoLaps(s).forEach(l => {
                add([
                    { v: l.lapNum, s: 6 },
                    { v: l.cycleNum != null ? l.cycleNum : '', s: 6 },
                    { v: l.stepName || '', s: 6 },
                    { v: l.stepType || '', s: 6 },
                    { v: l.formattedLap, s: 6 },
                    { v: l.formattedTotal, s: 6 },
                    { v: l.lapDurationMs, s: 6 },
                    { v: l.excluded ? 'yes' : '', s: 6 },
                    { v: l.note || '', s: 6 }
                ]);
            });
            add([{ v: 'Total', s: 7 }, { v: '', s: 7 }, { v: '', s: 7 }, { v: '', s: 7 }, { v: s.formattedTotalDuration, s: 7 }, { v: '', s: 7 }, { v: s.totalDurationMs, s: 7 }, { v: '', s: 7 }, { v: '', s: 7 }]);
            gap(2);
            if (si < sessions.length - 1) breaks.push(r - 1);
        });

        const widths = [8, 8, 18, 8, 16, 16, 14, 8, 24];
        let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
            + '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>'
            + '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
        rows.forEach(row => {
            x += `<row r="${row.r}">` + row.cells.map((c, i) => {
                const ref = `${col(i)}${row.r}`;
                if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>`;
                return `<c r="${ref}" s="${c.s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
            }).join('') + '</row>';
        });
        return x + '</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
            + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
            + (breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">` + breaks.map(b => `<brk id="${b}" max="16383" man="1"/>`).join('') + '</rowBreaks>' : '')
            + '</worksheet>';
    }

    function buildXLSX(sessions) {
        const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

        const sessHeaders = [
            'Process Name', 'Category', 'Date', 'Total', 'Total (ms)', 'Laps', 'Included Units', 'Excluded Units',
            'Fastest', 'Average (OT)', 'Slowest', 'Std Dev (ms)', 'CV (%)',
            'Rating %', 'Allowance %', 'Normal Time (ms)', 'Standard Time (ms)',
            'TTD (h)', 'TTD (m)', 'Demand', 'Takt Time (ms)',
            'Std Pieces/Hour', 'Std Pieces in TTD', 'Best Std pcs/h', 'Worst Std pcs/h'
        ];
        const sessRows = sessions.map(s => {
            const st = computeStats(s); const ev = estimatorValues(s);
            return [
                s.name, s.category || 'General', s.formattedDate, s.formattedTotalDuration, s.totalDurationMs,
                (s.laps || []).length, st.n, st.excludedN,
                fmt(st.min), fmt(st.avg), fmt(st.max), Math.round(st.std), +st.cv.toFixed(2),
                ev.performancePct, ev.allowancePct, Math.round(ev.normalMs), Math.round(ev.standardMs),
                ev.ttdH, ev.ttdM, ev.demandUnits, ev.taktMs != null ? Math.round(ev.taktMs) : '',
                ev.perHour != null ? +ev.perHour.toFixed(2) : '',
                ev.perTTD != null ? ev.perTTD : '',
                ev.bestHour != null ? +ev.bestHour.toFixed(2) : '',
                ev.worstHour != null ? +ev.worstHour.toFixed(2) : ''
            ];
        });

        const lapHeaders = ['Process Name', 'Category', 'Date', 'Lap #', 'Cycle #', 'Step', 'Type', 'Duration', 'Cumulative', 'Duration (ms)', 'Vs Avg (ms)', 'Excluded', 'Note'];
        const lapRows = [];
        sessions.forEach(s => {
            const st = computeStats(s);
            chronoLaps(s).forEach(l => {
                const diff = l.lapDurationMs - st.avg;
                lapRows.push([
                    s.name, s.category || 'General', s.formattedDate, l.lapNum,
                    l.cycleNum != null ? l.cycleNum : '', l.stepName || '', l.stepType || '',
                    l.formattedLap, l.formattedTotal, l.lapDurationMs,
                    isFinite(diff) ? Math.round(diff) : '',
                    l.excluded ? 'yes' : 'no', l.note || ''
                ]);
            });
        });

        return zipStore([
            { name: '[Content_Types].xml', content:
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
            { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
            { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Report" sheetId="3" r:id="rId3"/><sheet name="Sessions" sheetId="1" r:id="rId1"/><sheet name="Laps" sheetId="2" r:id="rId2"/></sheets></workbook>` },
            { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL + '/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="' + REL + '/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>' },
            { name: 'xl/styles.xml', content:
                `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}">` +
                '<fonts count="7">' +
                '<font><sz val="11"/><name val="Calibri"/></font>' +
                '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
                '<font><b/><sz val="16"/><name val="Calibri"/></font>' +
                '<font><b/><sz val="13"/><name val="Calibri"/></font>' +
                '<font><sz val="9"/><color rgb="FF595959"/><name val="Calibri"/></font>' +
                '<font><sz val="10"/><name val="Courier New"/></font>' +
                '<font><b/><sz val="10"/><name val="Courier New"/></font></fonts>' +
                '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEBEBEB"/><bgColor indexed="64"/></patternFill></fill></fills>' +
                '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF808080"/></top><bottom/><diagonal/></border></borders>' +
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
                '<cellXfs count="8">' +
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
                '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
                '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
                '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
                '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
                '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>' +
                '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left"/></xf>' +
                '<xf numFmtId="0" fontId="6" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf></cellXfs>' +
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
            { name: 'xl/worksheets/sheet1.xml', content: sheetXml(sessHeaders, sessRows, [30, 20, 22, 16, 14, 8, 12, 12, 14, 14, 14, 14, 10, 8, 10, 14, 16, 8, 8, 10, 14, 14, 14, 14, 14]) },
            { name: 'xl/worksheets/sheet2.xml', content: sheetXml(lapHeaders, lapRows, [30, 20, 22, 8, 8, 18, 8, 16, 18, 14, 14, 10, 24]) },
            { name: 'xl/worksheets/sheet3.xml', content: reportSheetXml(sessions) }
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
        const fill = (yy, h, gray) => ops.push(`${gray} g ${M} ${yy - 4} ${W - 2 * M} ${h} re f`);

        function newPage(title) {
            ops = []; pages.push(ops); y = H - M;
            if (title) {
                text('F2', 16, M, y - 12, 'Process Timer Pro - Records');
                text('F1', 9, M, y - 28, 'Generated ' + new Date().toLocaleString(), 0.4);
                y -= 44; rule(y); y -= 16;
            }
        }
        function tableHeader() {
            fill(y, ROW + 2, 0.92);
            text('F2', 9, M + 6, y, 'Lap');
            text('F2', 9, M + 40, y, 'Cyc');
            text('F2', 9, M + 72, y, 'Step');
            text('F2', 9, M + 175, y, 'Type');
            text('F2', 9, M + 215, y, 'Duration');
            text('F2', 9, M + 310, y, 'Cumulative');
            text('F2', 9, M + 405, y, 'ms');
            text('F2', 9, M + 460, y, 'Excl');
            y -= ROW + 3;
        }

        newPage(true);
        if (sessions.length === 0) text('F1', 11, M, y, 'No records.');

        sessions.forEach(s => {
            const st = computeStats(s);
            const ev = estimatorValues(s);
            if (y < 260) newPage(false);

            text('F2', 13, M, y, clip(s.name, 70)); y -= 16;
            text('F1', 9, M, y, `Category: ${clip(s.category || 'General', 40)}   |   Recorded: ${s.formattedDate}`, 0.35); y -= 13;
            text('F1', 9, M, y, `Total: ${s.formattedTotalDuration}   |   Laps: ${(s.laps || []).length} (included ${st.n} ${st.mode}, excluded ${st.excludedN})`, 0.35); y -= 13;
            text('F1', 9, M, y, `Fastest: ${fmt(st.min)}   Average (OT): ${fmt(st.avg)}   Slowest: ${fmt(st.max)}   StdDev: ${(st.std / 1000).toFixed(3)} s   CV: ${st.cv.toFixed(1)}%`, 0.35); y -= 16;

            if (ev.perHour != null) {
                ops.push(`0.98 0.98 0.90 rg ${M} ${y - 4} ${W - 2 * M} 54 re f`);
                text('F2', 10, M + 6, y, 'Standard Time & Takt'); y -= 13;
                text('F1', 9, M + 6, y, `Rating: ${ev.performancePct}%   |   Allowance: ${ev.allowancePct}%   |   Normal: ${fmt(ev.normalMs)}   |   Standard (ST): ${fmt(ev.standardMs)}`, 0.15); y -= 11;
                text('F1', 9, M + 6, y, `TTD: ${ev.availLabel}   |   Takt: ${ev.taktMs != null ? fmt(ev.taktMs) : '--'}   |   Std Output: ${ev.perHour.toFixed(1)} pcs/h (${ev.perTTD} in TTD)`, 0.15); y -= 17;
                y -= 4;
            }

            tableHeader();
            chronoLaps(s).forEach(l => {
                if (y < M + 20) { newPage(false); text('F2', 10, M, y, clip(s.name, 70) + ' (continued)', 0.35); y -= 16; tableHeader(); }
                text('F3', 9, M + 6, y, String(l.lapNum));
                text('F3', 9, M + 40, y, l.cycleNum != null ? 'C' + l.cycleNum : '-');
                text('F3', 9, M + 72, y, clip(l.stepName || '', 18));
                text('F3', 9, M + 175, y, l.stepType || '');
                text('F3', 9, M + 215, y, l.formattedLap);
                text('F3', 9, M + 310, y, l.formattedTotal);
                text('F3', 9, M + 405, y, String(l.lapDurationMs));
                if (l.excluded) text('F3', 9, M + 460, y, 'X');
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
        menu.className = 'fixed z-[70] w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-1 text-xs font-medium text-slate-200';
        const items = [
            ['csv', 'table', 'CSV (long — full detail)'],
            ['widecsv', 'table-2', 'CSV (wide — laps × cols)'],
            ['xlsx', 'file-spreadsheet', 'Excel (.xlsx) — 3 sheets'],
            ['pdf', 'file-text', 'PDF (report)'],
            ['json', 'file-json', 'JSON (data backup)']
        ];
        menu.innerHTML = items.map(([f, icon, label]) =>
            `<button data-fmt="${f}" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-left"><i data-lucide="${icon}" class="w-4 h-4 text-indigo-400"></i>${label}</button>`).join('');
        document.body.appendChild(menu);
        const r = event.currentTarget.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - 232, r.right - 224));
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