import {simpleParser, type ParsedMail} from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import {convert} from 'html-to-text';
import {createHash} from 'node:crypto';
import {PublicError} from '../shared/protocol.js';

export const MAX_MESSAGE = 12 * 1024 * 1024;
export const MAX_TEXT = 64_000;
export const MAX_HTML = 2 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_TAGS = 20_000;

export function parseMail(raw: Buffer) {
  // Preserve mailparser's mixed-part ordering and charset/transfer decoding.
  // Its converter handles some layouts; extractBody covers the HTML-only gaps.
  return simpleParser(raw, {skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: MAX_HTML});
}

export function extractBody(mail: Pick<ParsedMail, 'text' | 'html'>) {
  let text = mail.text ?? '';
  let source: 'parsed_text' | 'html' | 'none' = 'parsed_text';
  const reasons: string[] = [];
  if (!text.trim()) {
    text = '';
    source = typeof mail.html === 'string' && mail.html.trim() ? 'html' : 'none';
    if (source === 'html') {
      const html = mail.html as string;
      if (html.length > MAX_HTML) reasons.push('html_input_limit');
      else {
        let depth = 0, tags = 0;
        try {
          const clean = sanitizeHtml(html, {
            allowedTags: sanitizeHtml.defaults.allowedTags,
            allowedAttributes: {a: ['href']},
            allowedSchemes: ['https', 'http', 'mailto'],
            allowProtocolRelative: false,
            // Never execute markup, load remote resources, or include executable text.
            nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'svg'],
            onOpenTag: () => {
              if (++depth > MAX_DEPTH || ++tags > MAX_TAGS) throw new Error('structure_limit');
            },
            onCloseTag: () => { depth--; },
          });
          if (clean.length > MAX_HTML) reasons.push('html_input_limit');
          else {
            // Sanitizer preflight bounds depth and node count. Do not let the
            // converter silently truncate input, children, or deep quoted replies.
            text = convert(clean, {wordwrap: false, limits: {maxInputLength: MAX_HTML},
              baseElements: {selectors: [], returnDomByDefault: true},
              selectors: [{selector: 'img', format: 'skip'}]});
          }
        } catch (error) {
          reasons.push(error instanceof Error && error.message === 'structure_limit'
            ? 'html_structure_limit' : 'html_conversion_failed');
        }
      }
    }
    if (!text.trim() && !reasons.length) reasons.push('no_readable_text');
  }
  const truncated = text.length > MAX_TEXT;
  if (truncated) reasons.push('text_output_limit');
  return {text: text.slice(0, MAX_TEXT), truncated,
    body: {source, status: truncated ? 'truncated' : reasons.length ? 'incomplete' : 'complete',
      incomplete: reasons.length > 0, reasons,
      recoveryTool: reasons.length ? 'proton_read_source' : null}};
}

export function sourcePage(source: Buffer, offset: number, limit: number, expectedHash?: string) {
  if (source.length > MAX_MESSAGE)
    throw new PublicError('source_too_large', 'Decoded source exceeds 12 MiB. Request raw_mime instead.');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (expectedHash && sourceSha256 !== expectedHash)
    throw new PublicError('source_changed', 'Source changed. Start again at offset zero.');
  if (offset > source.length) throw new PublicError('invalid_offset', 'Offset is beyond the end of the source.');
  const end = Math.min(offset + limit, source.length);
  return {encoding: 'base64', base64: source.subarray(offset, end).toString('base64'),
    offset, bytes: end - offset, totalBytes: source.length,
    nextOffset: end < source.length ? end : null, sourceSha256};
}
