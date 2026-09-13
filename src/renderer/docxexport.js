/**
 * docx-export.js — генерация настоящего .docx (OOXML) из markdown-ответов.
 *
 * Зависимостей нет: .docx — это ZIP-архив из XML-файлов, а ZIP мы
 * собираем встроенным store-паковщиком (без сжатия — Word открывает
 * такие архивы без проблем). Markdown парсится тем же набором правил,
 * что и AnswerPanel.renderMarkdown, но рендерится в WordprocessingML.
 *
 * Публичное API:
 *   DocxExport.build(topic, nodes) -> Uint8Array   // байты .docx
 */
window.DocxExport = (() => {

  // ─── XML escape ───────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // ══════════════════════════════════════════════════════════════
  //  INLINE MARKDOWN → runs (<w:r>)
  //  Поддержка: **bold**, *italic*, ***bold-italic***, `code`,
  //  ~~strike~~, [text](url). Возвращает массив run-XML строк.
  // ══════════════════════════════════════════════════════════════
  function inlineRuns(text) {
    const tokens = [];
    let i = 0;
    const push = (t, fmt) => { if (t) tokens.push({ t, fmt: fmt || {} }); };

    // Простая последовательная токенизация
    const re = /(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(~~(.+?)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) push(text.slice(last, m.index), {});
      if (m[2] != null)      push(m[2], { b: true, i: true });
      else if (m[4] != null) push(m[4], { b: true });
      else if (m[6] != null) push(m[6], { i: true });
      else if (m[8] != null) push(m[8], { strike: true });
      else if (m[10] != null) push(m[10], { code: true });
      else if (m[12] != null) push(m[12], { link: m[13] });
      last = re.lastIndex;
    }
    if (last < text.length) push(text.slice(last), {});

    return tokens.map(({ t, fmt }) => {
      const rPr = [];
      if (fmt.b) rPr.push('<w:b/>');
      if (fmt.i) rPr.push('<w:i/>');
      if (fmt.strike) rPr.push('<w:strike/>');
      if (fmt.code || fmt.link) {
        if (fmt.code) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F0F0F8"/>');
        if (fmt.link) rPr.push('<w:color w:val="5C4EF5"/><w:u w:val="single"/>');
      }
      const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
      // xml:space=preserve чтобы не терять пробелы по краям
      return `<w:r>${rPrXml}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
    }).join('');
  }

  // Параграф со стилем и (опц.) отступом нумерации
  function para(runsXml, opts = {}) {
    const pPr = [];
    if (opts.style)  pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
    if (opts.numId != null) {
      pPr.push(`<w:numPr><w:ilvl w:val="${opts.ilvl || 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
    }
    if (opts.shd)    pPr.push(`<w:shd w:val="clear" w:fill="${opts.shd}"/>`);
    if (opts.border) pPr.push('<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="5C4EF5"/></w:pBdr>');
    if (opts.spacingBefore || opts.spacingAfter) {
      pPr.push(`<w:spacing ${opts.spacingBefore ? `w:before="${opts.spacingBefore}"` : ''} ${opts.spacingAfter ? `w:after="${opts.spacingAfter}"` : ''}/>`);
    }
    const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
    return `<w:p>${pPrXml}${runsXml}</w:p>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  BLOCK MARKDOWN → параграфы документа
  // ══════════════════════════════════════════════════════════════
  function blocksFromMarkdown(md) {
    if (!md) return '';
    const out = [];
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let i = 0;

    while (i < lines.length) {
      let line = lines[i];

      // Fenced code block
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // закрывающий ```
        code.forEach(cl => {
          out.push(para(
            `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(cl) || '&#160;'}</w:t></w:r>`,
            { style: 'KSCode', shd: 'F0F0F8' }
          ));
        });
        continue;
      }

      // Headings
      const h = line.match(/^(#{1,4})\s+(.+)$/);
      if (h) {
        const lvl = h[1].length;
        out.push(para(inlineRuns(h[2]), { style: `Heading${lvl}` }));
        i++; continue;
      }

      // HR
      if (/^---+\s*$/.test(line)) {
        out.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>`);
        i++; continue;
      }

      // Table (| ... | header, | --- | divider, rows)
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
        const tbl = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { tbl.push(lines[i]); i++; }
        out.push(buildTable(tbl));
        continue;
      }

      // Blockquote / callout
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
        // callout-маркер [!NOTE] и т.п. — просто убираем тег, выделяем рамкой
        const first = quote[0]?.match(/^\[!(NOTE|WARNING|TIP|INFO)\]\s*(.*)$/i);
        if (first) { quote[0] = first[2]; if (!quote[0]) quote.shift(); }
        quote.forEach(q => out.push(para(inlineRuns(q), { border: true, shd: 'F5F5FC', style: 'KSQuote' })));
        continue;
      }

      // Unordered list
      let ul = line.match(/^(\s*)[-*]\s+(.+)$/);
      if (ul) {
        while (i < lines.length && (ul = lines[i].match(/^(\s*)[-*]\s+(.+)$/))) {
          const ilvl = Math.min(Math.floor(ul[1].length / 2), 2);
          out.push(para(inlineRuns(ul[2]), { numId: 2, ilvl }));
          i++;
        }
        continue;
      }

      // Ordered list
      let ol = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (ol) {
        while (i < lines.length && (ol = lines[i].match(/^(\s*)\d+\.\s+(.+)$/))) {
          const ilvl = Math.min(Math.floor(ol[1].length / 2), 2);
          out.push(para(inlineRuns(ol[2]), { numId: 1, ilvl }));
          i++;
        }
        continue;
      }

      // Blank line → пропускаем (интервалы задаёт стиль)
      if (/^\s*$/.test(line)) { i++; continue; }

      // Обычный параграф — собираем подряд идущие непустые строки
      const buf = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,4}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i]) &&
             !/^---+\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push(para(inlineRuns(buf.join(' ')), { style: 'KSBody' }));
    }

    return out.join('');
  }

  function buildTable(rows) {
    const parseRow = r => r.replace(/^\||\|\s*$/g, '').split('|').map(c => c.trim());
    const header = parseRow(rows[0]);
    const body = rows.slice(2).map(parseRow);

    const cell = (text, isHead) => {
      const shd = isHead ? '<w:shd w:val="clear" w:fill="5C4EF5"/>' : '';
      const runs = isHead
        ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
        : inlineRuns(text);
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${runs}</w:p></w:tc>`;
    };

    const headRow = `<w:tr>${header.map(h => cell(h, true)).join('')}</w:tr>`;
    const bodyRows = body.map(r => `<w:tr>${r.map(c => cell(c, false)).join('')}</w:tr>`).join('');

    return `<w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="KSTable"/>
        <w:tblW w:w="5000" w:type="pct"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:color="DDDDDD"/><w:left w:val="single" w:sz="4" w:color="DDDDDD"/>
          <w:bottom w:val="single" w:sz="4" w:color="DDDDDD"/><w:right w:val="single" w:sz="4" w:color="DDDDDD"/>
          <w:insideH w:val="single" w:sz="4" w:color="DDDDDD"/><w:insideV w:val="single" w:sz="4" w:color="DDDDDD"/>
        </w:tblBorders>
      </w:tblPr>
      ${headRow}${bodyRows}
    </w:tbl><w:p/>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  Сборка document.xml
  // ══════════════════════════════════════════════════════════════
  function buildDocumentXml(topic, nodes) {
    const today = new Date().toLocaleDateString('ru');

    // Титул
    let body = '';
    body += para(`<w:r><w:rPr><w:b/><w:sz w:val="56"/><w:color w:val="1A1A2E"/></w:rPr><w:t xml:space="preserve">${esc(topic.name)}</w:t></w:r>`, { spacingAfter: 60 });
    body += para(`<w:r><w:rPr><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">Сгенерировано Knowledge Studio · ${esc(today)}</w:t></w:r>`, { spacingAfter: 240 });

    // Оглавление
    body += para(`<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Содержание</w:t></w:r>`, { spacingBefore: 120, spacingAfter: 60 });
    nodes.forEach((n, idx) => {
      const indent = (n._depth || 0) * 360;
      body += `<w:p><w:pPr><w:ind w:left="${indent}"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:color w:val="5C4EF5"/></w:rPr><w:t xml:space="preserve">${idx + 1}. ${esc(n.label)}</w:t></w:r></w:p>`;
    });

    // Разрыв страницы перед содержанием
    body += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

    // Секции
    nodes.forEach(n => {
      body += para(inlineRuns(n.label), { style: 'Heading1', spacingBefore: 240 });
      body += blocksFromMarkdown(n.answer);
    });

    const sectPr = `<w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}${sectPr}</w:body>
</w:document>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  styles.xml — заголовки, тело, код, цитата
  // ══════════════════════════════════════════════════════════════
  function buildStylesXml() {
    const heading = (id, name, size, color, before) =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="KSBody"/>
        <w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/></w:pPr>
        <w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>
      </w:style>`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="KSBody"><w:name w:val="KS Body"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="1A1A2E"/></w:rPr></w:style>
  ${heading('Heading1', 'heading 1', 36, '2A2A4A', 240)}
  ${heading('Heading2', 'heading 2', 30, '2A2A4A', 200)}
  ${heading('Heading3', 'heading 3', 26, '3A3A5A', 160)}
  ${heading('Heading4', 'heading 4', 22, '3A3A5A', 120)}
  <w:style w:type="paragraph" w:styleId="KSCode"><w:name w:val="KS Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="KSQuote"><w:name w:val="KS Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="44445A"/><w:i/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="KSTable"><w:name w:val="KS Table"/><w:basedOn w:val="TableNormal"/></w:style>
  <w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
</w:styles>`;
  }

  // numbering.xml — два списка: маркированный (numId 2) и нумерованный (numId 1)
  function buildNumberingXml() {
    const levels = (fmt) => Array.from({ length: 3 }, (_, l) => {
      const txt = fmt === 'bullet' ? '<w:lvlText w:val="•"/>' : `<w:lvlText w:val="%${l + 1}."/>`;
      const numFmt = fmt === 'bullet' ? 'bullet' : 'decimal';
      const font = fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>' : '';
      return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>${txt}<w:lvlJc w:val="left"/>
        <w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal')}</w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  ZIP (store / без сжатия) — чистый JS, без зависимостей
  // ══════════════════════════════════════════════════════════════
  const enc = new TextEncoder();

  // CRC32
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    // files: [{ name, data: Uint8Array }]
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const local = [
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(size), ...u32(size),
        ...u16(nameBytes.length), ...u16(0),
      ];
      chunks.push(new Uint8Array(local), nameBytes, f.data);

      central.push([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(size), ...u32(size),
        ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset),
      ]);
      central.push(nameBytes);

      offset += local.length + nameBytes.length + size;
    }

    let centralSize = 0;
    const centralChunks = central.map(c => {
      const a = c instanceof Uint8Array ? c : new Uint8Array(c);
      centralSize += a.length;
      return a;
    });

    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);

    const all = [...chunks, ...centralChunks, end];
    const total = all.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let p = 0;
    for (const a of all) { result.set(a, p); p += a.length; }
    return result;
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC: собрать .docx
  // ══════════════════════════════════════════════════════════════
  function build(topic, nodes) {
    const filesXml = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`,
      'word/document.xml': buildDocumentXml(topic, nodes),
      'word/styles.xml': buildStylesXml(),
      'word/numbering.xml': buildNumberingXml(),
    };

    const files = Object.entries(filesXml).map(([name, xml]) => ({ name, data: enc.encode(xml) }));
    return zip(files);
  }

  return { build };
})();