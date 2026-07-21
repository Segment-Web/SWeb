import { formatText } from './ui.js';

let pass=0,fail=0;
const ok=(condition,label)=>{if(condition){pass++;console.log(`ok   ${label}`);}else{fail++;console.log(`FAIL ${label}`);}};

ok(formatText('встретимся в 19:00')==='встретимся в 19:00','ordinary numbers survive formatting');
ok(formatText('цена 500 руб')==='цена 500 руб','standalone numbers survive formatting');
ok(formatText('`код` и 7')==='<code>код</code> и 7','code placeholders do not consume unrelated numbers');

console.log(`\n${pass} ok, ${fail} fail`);
if(fail)process.exit(1);
