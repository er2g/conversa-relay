#!/bin/bash

# WhatsApp Codex Health Check Script

API_URL="http://localhost:3000/health"
TIMEOUT=10
ALERT_EMAIL=""  # E-posta bildirimi için ayarla

check_health() {
    response=$(curl -s -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$API_URL")

    if [ "$response" = "200" ]; then
        return 0
    else
        return 1
    fi
}

check_whatsapp() {
    result=$(curl -s --max-time $TIMEOUT "$API_URL" | grep -o '"isReady":true')

    if [ -n "$result" ]; then
        return 0
    else
        return 1
    fi
}

restart_service() {
    echo "[$(date)] Servis yeniden başlatılıyor..."
    sudo systemctl restart whatsapp-claude
    sleep 30
}

send_alert() {
    local message=$1
    echo "[$(date)] ALERT: $message"

    # E-posta gönder (yapılandırılmışsa)
    if [ -n "$ALERT_EMAIL" ]; then
        echo "$message" | mail -s "WhatsApp Codex Alert" "$ALERT_EMAIL"
    fi
}

# Ana kontrol
echo "[$(date)] Health check başlatıldı..."

if ! check_health; then
    send_alert "API yanıt vermiyor!"
    restart_service

    # Tekrar kontrol
    if ! check_health; then
        send_alert "API yeniden başlatma sonrası hala yanıt vermiyor!"
        exit 1
    fi
fi

if ! check_whatsapp; then
    echo "[$(date)] WhatsApp bağlantısı yok, QR kod taranması gerekebilir"
fi

echo "[$(date)] Health check tamamlandı - OK"
exit 0
