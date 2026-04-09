(function(global) {
  'use strict';

  function getSafeWebsite(website) {
    var value = String(website || '').trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) return 'https://' + value;
    return value;
  }

  function pdfEscape(text) {
    return String(text || '')
      .replace(/\u2014/g, ',').replace(/\u2013/g, '-')
      .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  var AFM = {
    ' ':250, '!':333, '"':408, '#':500, '$':500, '%':833, '&':778, "'":333,
    '(':333, ')':333, '*':500, '+':564, ',':250, '-':333, '.':250, '/':278,
    '0':500, '1':500, '2':500, '3':500, '4':500, '5':500, '6':500, '7':500,
    '8':500, '9':500, ':':278, ';':278, '<':564, '=':564, '>':564, '?':444,
    '@':921, 'A':722, 'B':667, 'C':667, 'D':722, 'E':611, 'F':556, 'G':722,
    'H':722, 'I':333, 'J':389, 'K':722, 'L':611, 'M':889, 'N':722, 'O':722,
    'P':556, 'Q':722, 'R':667, 'S':556, 'T':611, 'U':722, 'V':722, 'W':944,
    'X':722, 'Y':722, 'Z':611,
    'a':444, 'b':500, 'c':444, 'd':500, 'e':444, 'f':333, 'g':500, 'h':500,
    'i':278, 'j':278, 'k':500, 'l':278, 'm':778, 'n':500, 'o':500, 'p':500,
    'q':500, 'r':333, 's':389, 't':278, 'u':500, 'v':500, 'w':722, 'x':500,
    'y':500, 'z':444
  };

  function charWidth(char, size) {
    var units = AFM[char];
    return (units !== undefined ? units : 500) * size / 1000;
  }

  function textWidth(text, size) {
    var width = 0;
    for (var i = 0; i < text.length; i++) width += charWidth(text[i], size);
    return width;
  }

  function splitLongWord(word, maxWidth, size) {
    var safeWidth = maxWidth * 0.98;
    var chunks = [];
    var current = '';
    for (var i = 0; i < word.length; i++) {
      var ch = word.charAt(i);
      var next = current + ch;
      if (!current || textWidth(next, size) <= safeWidth) current = next;
      else {
        chunks.push(current);
        current = ch;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function wrapText(segment, maxWidth, size) {
    var safeWidth = maxWidth * 0.98;
    var words = String(segment || '').trim().split(/\s+/).filter(Boolean);
    var lines = [];
    var current = '';
    if (!words.length) return [''];
    words.forEach(function(word) {
      var pieces = textWidth(word, size) <= safeWidth ? [word] : splitLongWord(word, maxWidth, size);
      pieces.forEach(function(piece) {
        if (!current) {
          current = piece;
          return;
        }
        var next = current + ' ' + piece;
        if (textWidth(next, size) <= safeWidth) current = next;
        else {
          lines.push(current);
          current = piece;
        }
      });
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  function scaledLayoutValue(value, scale, minValue) {
    return Math.max(minValue, +(value * scale).toFixed(2));
  }

  function buildLayoutCandidates() {
    var scales = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6];
    return scales.map(function(scale, index) {
      return {
        id: 'fit-' + (index + 1),
        scale: scale,
        marginLeft: scaledLayoutValue(54, scale, 26),
        marginRight: scaledLayoutValue(54, scale, 26),
        topMargin: scaledLayoutValue(34, scale, 17),
        bottomMargin: scaledLayoutValue(54, scale, 24),
        nameFS: scaledLayoutValue(20, scale, 14.2),
        nameLH: scaledLayoutValue(17.5, scale, 14.1),
        smallFS: scaledLayoutValue(9, scale, 7.2),
        smallLH: scaledLayoutValue(10, scale, 7.8),
        dateFS: scaledLayoutValue(10.5, scale, 8.8),
        dateLH: scaledLayoutValue(12.2, scale, 9.4),
        bodyFS: scaledLayoutValue(12, scale, 8.8),
        bodyLH: scaledLayoutValue(19, scale, 12.4),
        headerGap: scaledLayoutValue(8.5, scale, 5),
        contactGap: scaledLayoutValue(1, scale, 0.8),
        ruleGap: scaledLayoutValue(1.25, scale, 1),
        dateGap: scaledLayoutValue(14.5, scale, 8.5),
        paragraphGap: scaledLayoutValue(10, scale, 2.5)
      };
    });
  }

  function buildBodyLines(text, textW, bodyFS, paragraphGap) {
    var paras = String(text || '').split(/\n\n+/).map(function(para) { return para.trim(); }).filter(Boolean);
    var flatLines = [];
    paras.forEach(function(para, paraIndex) {
      var segments = para.split('\n');
      var paraLines = [];
      segments.forEach(function(segment) {
        if (!segment.trim()) {
          paraLines.push({ line: '', isLast: true });
          return;
        }
        wrapText(segment, textW, bodyFS).forEach(function(line, lineIndex, all) {
          paraLines.push({ line: line, isLast: lineIndex === all.length - 1 });
        });
      });
      if (!paraLines.length) paraLines.push({ line: '', isLast: true });
      paraLines.forEach(function(item, lineIndex) {
        flatLines.push({
          line: item.line,
          isLast: item.isLast,
          afterGap: lineIndex === paraLines.length - 1 && paraIndex < paras.length - 1
        });
      });
    });
    return flatLines;
  }

  function buildHeaderPlan(options, layout, textW) {
    var owner = options.owner || {};
    var ownerName = String(owner.name || 'Your Name').trim() || 'Your Name';
    var phone = String(owner.phone || '').trim();
    var email = String(owner.email || '').trim();
    var website = String(owner.website || '').trim();
    var websiteUrl = getSafeWebsite(website);
    var nameLines = wrapText(ownerName, textW, layout.nameFS);
    var contactText = [phone, email, website].filter(Boolean).join('   |   ');
    var contactLines = contactText ? wrapText(contactText, textW, layout.smallFS) : [];
    var inlineHeader = nameLines.length === 1 && contactLines.length === 1 &&
      textWidth(nameLines[0], layout.nameFS) + textWidth(contactLines[0], layout.smallFS) + 16 <= textW;
    var dateText = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    var y = 792 - layout.topMargin;
    var headerHeight = inlineHeader
      ? Math.max(layout.nameLH, contactLines.length ? layout.smallLH : 0)
      : (nameLines.length * layout.nameLH + (contactLines.length ? layout.contactGap + contactLines.length * layout.smallLH : 0));
    y -= headerHeight;
    var ruleY = y - layout.ruleGap;
    var dateY = ruleY - layout.dateGap;
    var bodyStartY = dateY - layout.dateLH - layout.headerGap;
    return {
      ownerName: ownerName,
      phone: phone,
      email: email,
      website: website,
      websiteUrl: websiteUrl,
      nameLines: nameLines,
      contactLines: contactLines,
      inlineHeader: inlineHeader,
      dateText: dateText,
      ruleY: ruleY,
      dateY: dateY,
      bodyStartY: bodyStartY
    };
  }

  function countPages(layout, bodyLines, bodyStartY) {
    var pages = 1;
    var y = bodyStartY;
    bodyLines.forEach(function(item) {
      if (y < layout.bottomMargin + layout.bodyLH) {
        pages++;
        y = 792 - layout.topMargin;
      }
      y -= layout.bodyLH;
      if (item.afterGap) y -= layout.paragraphGap;
    });
    return pages;
  }

  function buildCoverLetterPlan(options, layout) {
    var text = String(options.text || '').trim();
    var textW = 612 - layout.marginLeft - layout.marginRight;
    var bodyLines = buildBodyLines(text, textW, layout.bodyFS, layout.paragraphGap);
    var header = buildHeaderPlan(options, layout, textW);
    var pageCount = countPages(layout, bodyLines, header.bodyStartY);
    return {
      layout: layout,
      text: text,
      textW: textW,
      header: header,
      bodyLines: bodyLines,
      pageCount: pageCount
    };
  }

  function chooseCoverLetterPlan(options) {
    var plans = buildLayoutCandidates().map(function(layout) {
      return buildCoverLetterPlan(options, layout);
    });
    var best = plans[0];
    for (var i = 1; i < plans.length; i++) {
      if (plans[i].pageCount < best.pageCount) best = plans[i];
    }
    return best;
  }

  function appendTextLine(ops, fontRef, fontSize, x, y, text, color) {
    if (color) ops.push(color);
    ops.push('BT /' + fontRef + ' ' + fontSize.toFixed(2) + ' Tf 1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + pdfEscape(text) + ') Tj ET');
    if (color) ops.push('0 g');
  }

  function renderPlanToPageStreams(plan) {
    var layout = plan.layout;
    var header = plan.header;
    var ops = [];
    var y = 792 - layout.topMargin;
    var x = layout.marginLeft;

    if (header.inlineHeader && header.nameLines.length && header.contactLines.length) {
      var contactWidth = textWidth(header.contactLines[0], layout.smallFS);
      appendTextLine(ops, 'F2', layout.nameFS, x, y, header.nameLines[0]);
      appendTextLine(ops, 'F1', layout.smallFS, x + plan.textW - contactWidth, y, header.contactLines[0], header.websiteUrl ? '0 0.35 0.75 rg' : null);
      y -= Math.max(layout.nameLH, layout.smallLH);
    } else {
      header.nameLines.forEach(function(line) {
        appendTextLine(ops, 'F2', layout.nameFS, x, y, line);
        y -= layout.nameLH;
      });

      if (header.contactLines.length) {
        y -= layout.contactGap;
        header.contactLines.forEach(function(line) {
          appendTextLine(ops, 'F1', layout.smallFS, x, y, line, header.websiteUrl ? '0 0.35 0.75 rg' : null);
          y -= layout.smallLH;
        });
      }
    }

    var ruleY = y - layout.ruleGap;
    ops.push('0.5 w ' + x + ' ' + ruleY.toFixed(2) + ' m ' + (612 - layout.marginRight).toFixed(2) + ' ' + ruleY.toFixed(2) + ' l S');
    appendTextLine(ops, 'F1', layout.dateFS, x, ruleY - layout.dateGap, header.dateText);

    var pageStreams = [];
    var currentOps = ops.slice();
    var bodyY = header.bodyStartY;

    if (!plan.bodyLines.length) {
      pageStreams.push(currentOps.join('\n'));
    } else {
      plan.bodyLines.forEach(function(item) {
        if (bodyY < layout.bottomMargin + layout.bodyLH) {
          pageStreams.push(currentOps.join('\n'));
          currentOps = [];
          bodyY = 792 - layout.topMargin;
        }
        var line = item.line;
        var spaceCount = (line.match(/ /g) || []).length;
        var charCount = line.length;
        var lineW = textWidth(line, layout.bodyFS);
        var extra = plan.textW - lineW;
        if (!item.isLast && spaceCount > 0 && extra > 0) {
          var Tc = extra / (charCount + 2 * spaceCount);
          var Tw = 2 * Tc;
          currentOps.push(Tc.toFixed(4) + ' Tc ' + Tw.toFixed(4) + ' Tw');
        } else {
          currentOps.push('0 Tc 0 Tw');
        }
        currentOps.push('BT /F1 ' + layout.bodyFS.toFixed(2) + ' Tf 1 0 0 1 ' + x.toFixed(2) + ' ' + bodyY.toFixed(2) + ' Tm (' + pdfEscape(line) + ') Tj ET');
        bodyY -= layout.bodyLH;
        if (item.afterGap) bodyY -= layout.paragraphGap;
      });
      pageStreams.push(currentOps.join('\n'));
    }

    return pageStreams;
  }

  function buildPdfFromStreams(pageStreams, plan) {
    var numPages = pageStreams.length;
    var fontBase = numPages + 1;
    var fontBold = numPages + 2;
    var annotId = numPages + 3;
    var firstPageId = numPages + 4;
    var pagesId = firstPageId + numPages;
    var catalogId = pagesId + 1;
    var totalObjs = catalogId;
    var pdf = '%PDF-1.4\n';
    var off = {};

    function obj(id, body) {
      off[id] = pdf.length;
      pdf += id + ' 0 obj\n' + body + '\nendobj\n';
    }

    pageStreams.forEach(function(stream, index) {
      obj(index + 1, '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    });
    obj(fontBase, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
    obj(fontBold, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>');

    var annot = '';
    if (plan.header.contactLines.length && plan.header.websiteUrl) {
      var contactWidth = 0;
      var contactY = 792 - plan.layout.topMargin;
      if (plan.header.inlineHeader) {
        contactWidth = textWidth(plan.header.contactLines[0], plan.layout.smallFS);
      } else {
        contactY -= plan.header.nameLines.length * plan.layout.nameLH;
        contactY -= plan.layout.contactGap;
        plan.header.contactLines.forEach(function(line) {
          contactWidth = Math.max(contactWidth, textWidth(line, plan.layout.smallFS));
        });
      }
      var top = contactY + plan.layout.smallFS + 2;
      var bottom = contactY - ((plan.header.contactLines.length - 1) * plan.layout.smallLH) - 2;
      annot = '<< /Type /Annot /Subtype /Link'
        + ' /Rect [' + (plan.header.inlineHeader ? (plan.layout.marginLeft + plan.textW - contactWidth) : plan.layout.marginLeft).toFixed(2) + ' ' + bottom.toFixed(2) + ' ' + (plan.header.inlineHeader ? (plan.layout.marginLeft + plan.textW) : (plan.layout.marginLeft + contactWidth)).toFixed(2) + ' ' + top.toFixed(2) + ']'
        + ' /Border [0 0 0]'
        + ' /A << /Type /Action /S /URI /URI (' + pdfEscape(plan.header.websiteUrl) + ') >> >>';
    }
    if (annot) obj(annotId, annot);
    else obj(annotId, '<< /Type /Annot /Subtype /Link /Rect [0 0 0 0] /Border [0 0 0] >>');

    var pageKids = [];
    for (var pageIndex = 0; pageIndex < numPages; pageIndex++) {
      var pageId = firstPageId + pageIndex;
      var annotsStr = (pageIndex === 0 && annot) ? ' /Annots [' + annotId + ' 0 R]' : '';
      obj(pageId, '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 612 792] /Contents ' + (pageIndex + 1) + ' 0 R' + annotsStr + ' /Resources << /Font << /F1 ' + fontBase + ' 0 R /F2 ' + fontBold + ' 0 R >> >> >>');
      pageKids.push(pageId + ' 0 R');
    }
    obj(pagesId, '<< /Type /Pages /Kids [' + pageKids.join(' ') + '] /Count ' + numPages + ' >>');
    obj(catalogId, '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');

    var xrefPos = pdf.length;
    pdf += 'xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n';
    for (var xid = 1; xid <= totalObjs; xid++) {
      pdf += String(off[xid]).padStart(10, '0') + ' 00000 n \n';
    }
    pdf += 'trailer\n<< /Size ' + (totalObjs + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
    return pdf;
  }

  function describeFit(plan) {
    return {
      layoutId: plan.layout.id,
      scale: plan.layout.scale,
      pageCount: plan.pageCount,
      onePageFit: plan.pageCount === 1,
      bodyFontSize: plan.layout.bodyFS,
      bodyLineHeight: plan.layout.bodyLH,
      nameFontSize: plan.layout.nameFS,
      margins: {
        left: plan.layout.marginLeft,
        right: plan.layout.marginRight,
        top: plan.layout.topMargin,
        bottom: plan.layout.bottomMargin
      },
      bodyLines: plan.bodyLines.length,
      contactLines: plan.header.contactLines.length,
      inlineHeader: !!plan.header.inlineHeader
    };
  }

  function measureCoverLetterFit(options) {
    options = options || {};
    if (!String(options.text || '').trim()) return null;
    return describeFit(chooseCoverLetterPlan(options));
  }

  function buildPdfFileName(jobTitle, company) {
    return ((String(jobTitle || 'Cover_Letter')) + (company ? '_' + String(company) : '') + '.pdf')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .replace(/_+/g, '_');
  }

  function buildCoverLetterPdfDownload(options) {
    options = options || {};
    var text = String(options.text || '').trim();
    var jobTitle = String(options.jobTitle || 'Cover Letter');
    var company = String(options.company || '').trim();
    if (!text) return null;

    var plan = chooseCoverLetterPlan(options);
    var pageStreams = renderPlanToPageStreams(plan);
    var pdf = buildPdfFromStreams(pageStreams, plan);
    var metadata = describeFit(plan);
    metadata.fileName = buildPdfFileName(jobTitle, company);
    return {
      dataUrl: 'data:application/pdf;base64,' + btoa(pdf),
      fileName: metadata.fileName,
      metadata: metadata
    };
  }

  function downloadCoverLetterPDF(options) {
    options = options || {};
    var text = String(options.text || '').trim();
    var status = typeof options.onStatus === 'function' ? options.onStatus : function() {};

    if (!text) {
      status('No cover letter available to export.', 'error');
      return null;
    }

    var payload = buildCoverLetterPdfDownload(options);
    if (!payload) {
      status('No cover letter available to export.', 'error');
      return null;
    }
    var byteString = atob(payload.dataUrl.split(',')[1]);
    var bytes = new Uint8Array(byteString.length);
    for (var i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = payload.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function() { URL.revokeObjectURL(anchor.href); }, 10000);

    var metadata = payload.metadata;
    metadata.downloaded = true;
    metadata.fileName = anchor.download;
    global.CoverCraftPdf.lastExport = metadata;
    if (options.onLayout) options.onLayout(metadata);
    status('PDF downloaded (' + metadata.pageCount + ' page' + (metadata.pageCount === 1 ? '' : 's') + ', ' + Math.round(metadata.scale * 100) + '% typography).', 'success');
    return metadata;
  }

  global.CoverCraftPdf = {
    buildCoverLetterPdfDownload: buildCoverLetterPdfDownload,
    downloadCoverLetterPDF: downloadCoverLetterPDF,
    measureCoverLetterFit: measureCoverLetterFit,
    lastExport: null
  };
})(typeof self !== 'undefined' ? self : window);
