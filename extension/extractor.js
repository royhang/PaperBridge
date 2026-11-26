/**
 * Page metadata & PDF link extractor injected into the active tab on click.
 * Supports CNKI (知网), arXiv, Wanfang/VIP, and all standard academic sites using
 * Highwire Press (`citation_*`) / Dublin Core (`DC.*`) meta tags.
 */
(() => {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const splitName = (raw) => {
    const s = clean(raw).replace(/\d+$/g, '').trim();
    if (!s) return null;
    const comma = s.indexOf(',');
    if (comma >= 0) return { family: s.slice(0, comma).trim(), given: s.slice(comma + 1).trim() };
    const han = /^([\u4e00-\u9fff])([\u4e00-\u9fff\s]+)$/.exec(s);
    if (han) return { family: han[1], given: han[2].replace(/\s/g, '') };
    const lastSpace = s.lastIndexOf(' ');
    return lastSpace < 0
      ? { family: s, given: '' }
      : { family: s.slice(lastSpace + 1), given: s.slice(0, lastSpace) };
  };

  const metas = (name) =>
    [...document.querySelectorAll(`meta[name="${name}" i], meta[property="${name}" i]`)]
      .map((el) => clean(el.getAttribute('content')))
      .filter(Boolean);
  const firstMeta = (...names) => {
    for (const n of names) {
      const v = metas(n)[0];
      if (v) return v;
    }
    return undefined;
  };
  const absUrl = (href) => {
    if (!href) return undefined;
    try {
      const u = new URL(href, location.href);
      return /^https?:$/i.test(u.protocol) ? u.href : undefined;
    } catch {
      return undefined;
    }
  };

  const host = location.hostname.toLowerCase();

  // ---- 1. CNKI (知网) ----
  if (/(?:^|\.)cnki\.(?:net|com\.cn)$/.test(host)) {
    const h1 = document.querySelector('.wx-tit h1, h1.title, .doc-title h1');
    let title = '';
    if (h1) {
      const clone = h1.cloneNode(true);
      clone.querySelectorAll('span, a, i, em, sup, sub').forEach((n) => n.remove());
      title = clean(clone.textContent) || clean(h1.textContent);
    }
    if (!title) title = firstMeta('citation_title', 'og:title') || clean(document.title).replace(/\s*[-–—]\s*中国知网.*$/, '');

    const authorEls = document.querySelectorAll('#authorpart a, .wx-tit .author a, .author span a, .author span');
    const rawAuthors = [];
    for (const el of authorEls) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('sup').forEach((n) => n.remove());
      const name = clean(clone.textContent).replace(/[;；,，\d]+$/g, '').trim();
      if (name && !rawAuthors.includes(name) && name.length <= 30) rawAuthors.push(name);
    }
    const authors = rawAuthors.map(splitName).filter(Boolean);

    const topTip = document.querySelector('.top-tip');
    const venueLink = topTip?.querySelector('a');
    let venue = clean(venueLink?.textContent) || firstMeta('citation_journal_title');
    const tipText = clean(topTip?.textContent);
    let year;
    let volume;
    let issue;
    let pages;
    // Match patterns like "2026(06): 42-49", "2026, 43(06): 42-49", "2026年06期"
    const mVolIssue = /(\d{4})\s*[,，.]?\s*(?:(\d+)\s*)?\((\d+|[A-Za-z0-9]+)\)(?:\s*[:：]\s*([\d\-–—+]+))?/.exec(tipText);
    if (mVolIssue) {
      year = Number(mVolIssue[1]);
      if (mVolIssue[2]) volume = mVolIssue[2];
      issue = mVolIssue[3];
      if (mVolIssue[4]) pages = mVolIssue[4];
    } else {
      const yMatch = /\b((?:19|20)\d{2})\b/.exec(tipText) || /\b((?:19|20)\d{2})\b/.exec(document.body.innerText.slice(0, 1500));
      if (yMatch) year = Number(yMatch[1]);
    }

    const abstract = clean(document.querySelector('#ChDivSummary, .abstract-text')?.textContent) || firstMeta('description');
    const keywords = [...document.querySelectorAll('.keywords a, p.keywords a')]
      .map((a) => clean(a.textContent).replace(/[;；,，]+$/g, ''))
      .filter(Boolean);

    // DOI & thesis school lookup from detail metadata rows
    let doi = firstMeta('citation_doi');
    let publisher;
    let type = 'article';
    for (const row of document.querySelectorAll('li.top-space, .rowtit, .brief .row')) {
      const t = clean(row.textContent);
      if (!doi) {
        const dm = /DOI\s*[:：]\s*(10\.\d{4,9}\/[^\s;；]+)/i.exec(t);
        if (dm) doi = dm[1];
      }
      if (/学位授予单位/.test(t)) {
        type = 'thesis';
        publisher = clean(t.replace(/.*学位授予单位\s*[:：]?/, ''));
        if (!venue) venue = publisher;
      }
    }
    if (/学位论文|硕士|博士/.test(tipText)) type = 'thesis';

    // CNKI PDF download link (#pdfDown or href containing dflag=pdfdown)
    const pdfAnchor =
      document.querySelector('#pdfDown, a[id*="pdfDown" i], a[href*="dflag=pdfdown" i], a.btn-dlpdf') ||
      [...document.querySelectorAll('a')].find((a) => /PDF\s*下载/i.test(a.textContent || ''));
    const pdfUrl = absUrl(pdfAnchor?.getAttribute('href'));

    return {
      sourceLabel: '知网 CNKI',
      meta: {
        title,
        authors,
        year,
        venue,
        volume,
        issue,
        pages,
        publisher,
        doi,
        url: location.href,
        abstract,
        language: 'zh',
        type,
      },
      tags: [...new Set(keywords)],
      pdfUrl,
      pdfFileName: title ? `${title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}${authors[0]?.family ? '_' + authors[0].family + authors[0].given : ''}.pdf` : undefined,
    };
  }

  // ---- 2. arXiv ----
  if (/^(?:www\.)?arxiv\.org$/.test(host)) {
    const idMatch = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i.exec(location.pathname);
    const arxivId = idMatch?.[1]?.replace(/v\d+$/i, '');
    const title = firstMeta('citation_title') || clean(document.querySelector('h1.title')?.textContent?.replace(/^Title:\s*/i, ''));
    const authors = metas('citation_author').map(splitName).filter(Boolean);
    const yearStr = firstMeta('citation_date', 'citation_online_date')?.match(/(?:19|20)\d{2}/)?.[0];
    const abstract = clean(document.querySelector('blockquote.abstract')?.textContent?.replace(/^Abstract:\s*/i, '')) || firstMeta('citation_abstract');
    const pdfUrl = firstMeta('citation_pdf_url') || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined);
    return {
      sourceLabel: 'arXiv',
      meta: {
        title,
        authors,
        year: yearStr ? Number(yearStr) : undefined,
        venue: 'arXiv',
        arxivId,
        doi: firstMeta('citation_doi'),
        url: arxivId ? `https://arxiv.org/abs/${arxivId}` : location.href,
        abstract,
        type: 'preprint',
      },
      tags: [],
      pdfUrl: absUrl(pdfUrl),
      pdfFileName: arxivId ? `${arxivId}.pdf` : undefined,
    };
  }

  // ---- 3. Universal Academic Meta Extractor (IEEE, ACM, Springer, Nature, ScienceDirect, PubMed, Wanfang, OpenReview, etc.) ----
  const title =
    firstMeta('citation_title', 'DC.Title', 'dc.title', 'og:title') ||
    clean(document.querySelector('h1')?.textContent) ||
    clean(document.title);
  const rawAuthors = metas('citation_author').length
    ? metas('citation_author')
    : metas('DC.Creator').length
      ? metas('DC.Creator')
      : metas('dc.creator');
  const authors = rawAuthors.map(splitName).filter(Boolean);
  const yearStr = firstMeta('citation_publication_date', 'citation_date', 'citation_year', 'DC.Date', 'dc.date')?.match(/(?:19|20)\d{2}/)?.[0];
  const venue = firstMeta('citation_journal_title', 'citation_conference_title', 'citation_inbook_title', 'DC.Source', 'citation_publisher');
  const firstPage = firstMeta('citation_firstpage');
  const lastPage = firstMeta('citation_lastpage');
  const pages = firstPage && lastPage ? `${firstPage}-${lastPage}` : firstPage;
  const doi = firstMeta('citation_doi', 'DC.Identifier.DOI', 'dc.identifier.doi')?.replace(/^doi:\s*/i, '');
  const abstract = firstMeta('citation_abstract', 'DC.Description', 'dc.description', 'description', 'og:description');
  const keywords = [...metas('citation_keywords'), ...metas('keywords')]
    .flatMap((k) => k.split(/[;；,，]+/))
    .map((k) => k.trim())
    .filter((k) => k && k.length <= 40);
  const pdfLink =
    firstMeta('citation_pdf_url') ||
    document.querySelector('link[type="application/pdf"]')?.getAttribute('href') ||
    document.querySelector('a[href$=".pdf" i]')?.getAttribute('href');
  const isConf = !!firstMeta('citation_conference_title');
  const isThesis = !!firstMeta('citation_dissertation_institution');

  return {
    sourceLabel: metas('citation_title').length ? host.replace(/^www\./, '') : '网页',
    meta: {
      title,
      authors,
      year: yearStr ? Number(yearStr) : undefined,
      venue,
      volume: firstMeta('citation_volume'),
      issue: firstMeta('citation_issue'),
      pages,
      publisher: firstMeta('citation_publisher', 'citation_dissertation_institution'),
      doi,
      url: location.href,
      abstract,
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type: isThesis ? 'thesis' : isConf ? 'conference' : 'article',
    },
    tags: [...new Set(keywords)].slice(0, 12),
    pdfUrl: absUrl(pdfLink),
    pdfFileName: title ? `${title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}.pdf` : undefined,
  };
})();
