import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) { const d = await PDFDocument.load(readFileSync(f), {ignoreEncryption:true, updateMetadata:false}); console.log(f.split('/').pop(), d.getPageCount(), d.getProducer(), '|', d.getCreator(), d.getPage(0).getSize()); }
