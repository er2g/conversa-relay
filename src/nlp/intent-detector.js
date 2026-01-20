import logger from '../logger.js';

class IntentDetector {
  constructor() {
    // Türkçe intent kalıpları
    this.patterns = {
      greeting: {
        keywords: [
          'selam', 'merhaba', 'hey', 'naber', 'nasılsın', 'napıyorsun',
          'sa', 'slm', 'mrb', 'selamlar', 'günaydın', 'iyi akşamlar',
          'iyi günler', 'hello', 'hi', 'alo', 'hocam', 'kanka', 'kardeş',
          'esenlikler', 'selam kanka', 'ne var ne yok', 'nasıl gidiyor'
        ],
        patterns: [
          /^(sa|slm|mrb|hey|hi|hello)$/i,
          /^selam+$/i,
          /^merhaba+$/i,
          /na(ber|sılsın|pıyorsun)/i
        ]
      },

      status: {
        keywords: [
          'durum', 'ne durumda', 'nasıl gidiyor', 'bitti mi', 'hallettim mi',
          'oldu mu', 'tamam mı', 'neredesin', 'ne aşamada', 'status',
          'bitirdin mi', 'yaptın mı', 'progress', 'ilerleme'
        ],
        patterns: [
          /ne\s*(durumda|aşamada)/i,
          /hall?ett?(in|im)?\s*mi/i,
          /(bitt?i|oldu|tamam|yaptın)\s*mı?/i,
          /nasıl\s*gidiyor/i
        ]
      },

      new_session: {
        keywords: [
          'yeni oturum', 'başlat', 'yeni session', 'oturum aç',
          'başla', 'yeni', 'oturum başlat', 'start'
        ],
        patterns: [
          /yeni\s*(oturum|session)/i,
          /oturum\s*(başlat|aç)/i,
          /^başla(t)?$/i
        ]
      },

      end_session: {
        keywords: [
          'oturumu kapat', 'bitir', 'kapat', 'session kapat', 'çık',
          'sonlandır', 'end session', 'bye', 'görüşürüz', 'bb'
        ],
        patterns: [
          /oturum(u)?\s*(kapat|bitir|sonlandır)/i,
          /(session|oturum)\s*(end|kapat)/i,
          /^(çık|kapat|bitir|bye|bb)$/i
        ]
      },

      list_sessions: {
        keywords: [
          'oturumlar', 'sessions', 'aktif oturumlar', 'kimler var',
          'oturum listesi', 'liste'
        ],
        patterns: [
          /oturum\s*(lar|listesi)/i,
          /aktif\s*(oturumlar|sessions)/i,
          /kimler\s*var/i
        ]
      },

      help: {
        keywords: [
          'yardım', 'help', 'nasıl kullanılır', 'komutlar', 'ne yapabilirsin',
          'özellikler', 'neler yaparsın', 'neleri yapabilirsin'
        ],
        patterns: [
          /^(yardım|help)$/i,
          /nasıl\s*kullan/i,
          /ne(ler)?\s*yapabilir/i,
          /komutlar/i
        ]
      },

      admin_command: {
        keywords: [],
        patterns: [
          /^\/stats$/i,
          /^\/kill[_\s]?all$/i,
          /^\/reload[_\s]?config$/i,
          /^\/admin/i
        ],
        extractCommand: (text) => {
          const match = text.match(/^\/(stats|kill[_\s]?all|reload[_\s]?config|admin\s+\w+)/i);
          if (match) {
            return match[1].replace(/[_\s]/g, '_').toLowerCase();
          }
          return null;
        }
      }
    };

    // Dosya işlemi anahtar kelimeleri
    this.fileKeywords = [
      'dosya', 'file', 'oluştur', 'create', 'düzenle', 'edit', 'sil', 'delete',
      'yaz', 'write', 'oku', 'read', 'aç', 'open', 'kaydet', 'save'
    ];

    // Kod işlemi anahtar kelimeleri
    this.codeKeywords = [
      'kod', 'code', 'script', 'fonksiyon', 'function', 'class', 'sınıf',
      'hata', 'bug', 'error', 'fix', 'düzelt', 'debug', 'test', 'çalıştır',
      'run', 'compile', 'derle', 'build'
    ];

    // Git işlemi anahtar kelimeleri
    this.gitKeywords = [
      'git', 'commit', 'push', 'pull', 'branch', 'merge', 'checkout',
      'status', 'diff', 'log', 'stash', 'clone', 'fetch'
    ];
  }

  detect(text) {
    const normalizedText = this.normalize(text);

    // Admin komutları önce kontrol et
    if (text.startsWith('/')) {
      const adminIntent = this.checkIntent('admin_command', normalizedText);
      if (adminIntent.match) {
        return {
          type: 'admin_command',
          command: this.patterns.admin_command.extractCommand(text),
          confidence: adminIntent.confidence,
          originalText: text
        };
      }
    }

    // Diğer intent'leri kontrol et
    const intents = [
      'greeting', 'status', 'new_session', 'end_session',
      'list_sessions', 'help'
    ];

    let bestMatch = { type: 'claude_command', confidence: 0 };

    for (const intentName of intents) {
      const result = this.checkIntent(intentName, normalizedText);
      if (result.match && result.confidence > bestMatch.confidence) {
        bestMatch = {
          type: intentName,
          confidence: result.confidence,
          matchedKeyword: result.matchedKeyword,
          matchedPattern: result.matchedPattern
        };
      }
    }

    // Eşik değeri altındaysa Claude'a gönder
    if (bestMatch.confidence < 0.6) {
      bestMatch = {
        type: 'claude_command',
        confidence: 1,
        subType: this.detectCommandType(normalizedText)
      };
    }

    bestMatch.originalText = text;
    return bestMatch;
  }

  checkIntent(intentName, text) {
    const intent = this.patterns[intentName];
    let confidence = 0;
    let matchedKeyword = null;
    let matchedPattern = null;

    // Keyword kontrolü
    for (const keyword of intent.keywords) {
      if (text.includes(keyword)) {
        const keywordConfidence = this.calculateKeywordConfidence(text, keyword);
        if (keywordConfidence > confidence) {
          confidence = keywordConfidence;
          matchedKeyword = keyword;
        }
      }
    }

    // Pattern kontrolü
    for (const pattern of intent.patterns) {
      if (pattern.test(text)) {
        const patternConfidence = 0.9; // Pattern eşleşmesi yüksek güven
        if (patternConfidence > confidence) {
          confidence = patternConfidence;
          matchedPattern = pattern.toString();
        }
      }
    }

    return {
      match: confidence > 0.5,
      confidence,
      matchedKeyword,
      matchedPattern
    };
  }

  calculateKeywordConfidence(text, keyword) {
    // Tam eşleşme yüksek güven
    if (text === keyword) return 0.95;

    // Başlangıçta eşleşme
    if (text.startsWith(keyword + ' ') || text.startsWith(keyword + ',')) return 0.85;

    // Kelime olarak eşleşme
    const wordBoundary = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
    if (wordBoundary.test(text)) return 0.75;

    // Parça olarak eşleşme
    return 0.55;
  }

  detectCommandType(text) {
    // Dosya işlemi mi?
    for (const keyword of this.fileKeywords) {
      if (text.includes(keyword)) {
        return 'file_operation';
      }
    }

    // Kod işlemi mi?
    for (const keyword of this.codeKeywords) {
      if (text.includes(keyword)) {
        return 'code_operation';
      }
    }

    // Git işlemi mi?
    for (const keyword of this.gitKeywords) {
      if (text.includes(keyword)) {
        return 'git_operation';
      }
    }

    return 'general';
  }

  normalize(text) {
    return text
      .toLowerCase()
      .trim()
      // Türkçe karakter normalizasyonu
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      // Fazla boşlukları temizle
      .replace(/\s+/g, ' ');
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export default IntentDetector;
