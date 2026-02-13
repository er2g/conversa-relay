#!/usr/bin/env node
/**
 * Claude'un WhatsApp'a dosya göndermesi için outbox media scripti.
 * Kullanım: node scripts/ai-outbox-media.js --file /mutlak/dosya/yolu --caption "Açıklama"
 */
import { getOutboxPaths, writeOutboxMessage } from '../src/outbox/common.js';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

function printUsage() {
  console.log([
    'Kullanim:',
    '  node scripts/ai-outbox-media.js --file /mutlak/yol/dosya.pdf --caption "Açıklama"',
    '',
    'Opsiyonlar:',
    '  --file, --path    Gonderilecek dosyanin mutlak yolu (zorunlu)',
    '  --caption, --text Dosya aciklamasi (opsiyonel)',
    '  --chat            Hedef chatId (opsiyonel, WA_CHAT_ID yoksa gerekli)',
    '  --request         Request id (opsiyonel)',
    '  --orchestrator    codex|claude|gemini (opsiyonel)',
    '  --help            Yardim'
  ].join('\n'));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  const filePath = flags.file || flags.path;
  if (!filePath) {
    console.error('Hata: Dosya yolu gerekli (--file).');
    printUsage();
    process.exit(2);
  }

  const caption = flags.caption || flags.text || '';
  const outboxPaths = getOutboxPaths(process.env.AI_OUTBOX_DIR);

  const result = await writeOutboxMessage(
    {
      chatId: flags.chat || process.env.WA_CHAT_ID,
      requestId: flags.request || process.env.WA_REQUEST_ID || null,
      orchestrator: flags.orchestrator || process.env.WA_ORCHESTRATOR || null,
      type: 'media',
      text: caption,
      filePath
    },
    { outboxPaths }
  );

  console.log(JSON.stringify({
    ok: true,
    file: result.filePath,
    requestId: result.envelope.requestId,
    type: result.envelope.type,
    mediaPath: filePath
  }));
}

main().catch((error) => {
  console.error(`Hata: ${error?.message || String(error)}`);
  process.exit(1);
});
