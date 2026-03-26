# StreamBridge

Addon Stremio para Jellyfin com suporte a **múltiplas instâncias**, fallback automático e priorização de transcodificação.

## Funcionalidades
- Multi-instância (VPS primário + PC local secundário)
- Fallback automático se instância secundária estiver offline
- Catálogo mesclado com deduplicação por título+ano
- Episódios mesclados de ambas instâncias por S/E
- Cache em memória (catalog/meta: 5min · stream: 30s)
- Health check via `/health`
- Fetch nativo Node 18+ (sem dependências extras)

## Deploy

\`\`\`bash
npm install          # gera package-lock.json
docker compose up -d --build
\`\`\`

Acesse `http://localhost:7005/configure` para configurar.

## Requisitos
- Node >= 18
- Docker + Docker Compose
