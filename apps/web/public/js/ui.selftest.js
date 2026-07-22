import { formatText } from './ui.js';
import { safeMediaUrl } from './util.js';

let pass=0,fail=0;
const ok=(condition,label)=>{if(condition){pass++;console.log(`ok   ${label}`);}else{fail++;console.log(`FAIL ${label}`);}};

ok(formatText('встретимся в 19:00')==='встретимся в 19:00','ordinary numbers survive formatting');
ok(formatText('цена 500 руб')==='цена 500 руб','standalone numbers survive formatting');
ok(formatText('`код` и 7')==='<code>код</code> и 7','code placeholders do not consume unrelated numbers');

// Inline markers used to be applied to the anchor markup itself, so a marker
// pair inside a URL injected tags into the quoted href value and broke out of
// it. Every generated link must expose exactly one attribute-value boundary.
const hrefAttrs=(html)=>[...html.matchAll(/href="([^"]*)"/g)].map((m)=>m[1]);
for(const [input,label] of [
  ['http://x.com/||a||','spoiler markers'],
  ['http://x.com/**a**','bold markers'],
  ['||http://x.com/a||b||','a link inside a spoiler'],
]){
  const html=formatText(input);
  ok(!/href="[^"]*</.test(html),`no tag is injected into href by ${label}`);
  ok(hrefAttrs(html).every((value)=>!value.includes('<')&&!value.includes('>')),`href stays a plain url with ${label}`);
}
ok(formatText('http://x.com/a').includes('<a href="http://x.com/a"'),'a plain link still renders');
ok(formatText('**жирный**')==='<b>жирный</b>','markers outside a url still format');

// The hold() sentinels are private-use codepoints a sender can simply type.
// Stripped, not resolved: the digit stays literal text instead of naming an
// entry in codes[] (which used to render as "undefined", or another run's html).
ok(formatText('0')==='0','a typed placeholder is inert');
ok(formatText('`код`0')==='<code>код</code>0','a typed placeholder cannot steal a real run html');

// Attachment urls come off the wire; only the schemes this app emits are kept.
ok(safeMediaUrl('blob:https://web.segmnt.org/abc')!=='','blob url is allowed');
ok(safeMediaUrl('/api/files/abc')!=='','same-origin path is allowed');
ok(safeMediaUrl('data:image/png;base64,AAAA')!=='','image data url is allowed');
ok(safeMediaUrl('javascript:alert(1)')==='','javascript url is rejected');
ok(safeMediaUrl('  javascript:alert(1)')==='','padded javascript url is rejected');
ok(safeMediaUrl('data:text/html;base64,AAAA')==='','html data url is rejected');
ok(safeMediaUrl('data:image/svg+xml;base64,AAAA')==='','svg data url is rejected');
ok(safeMediaUrl('//evil.example/x.png')==='','protocol-relative url is rejected');
ok(safeMediaUrl('https://evil.example/x.png')==='','cross-origin url is rejected');

console.log(`\n${pass} ok, ${fail} fail`);
if(fail)process.exit(1);
