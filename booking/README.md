# Página de reservas pessoal

É uma página de agendamento no estilo do Calendly, mas sua: um único processo Node, um arquivo SQLite, sem contas e sem framework.

- **Página pública**: mostra os horários livres dos próximos 14 dias no fuso do visitante. O visitante escolhe um horário, informa nome, e-mail e uma nota, e cai numa página de confirmação.
- **Disponibilidade**: vem das regras semanais do `config.json`, menos as reservas existentes e os eventos ocupados do seu Google Calendar.
- **Google Calendar**: cada reserva cria um evento na sua agenda, com o visitante como convidado e um link do Google Meet.
- **E-mails**: confirmação para os dois lados por SMTP. Reagendamento e cancelamento também geram e-mail.
- **Cancelar e reagendar**: os links vão no e-mail e levam um token assinado (HMAC).

> ## ⚠ Leia antes: o OAuth do Google é a parte trabalhosa
>
> O código está pronto. **Reserve 1 hora só para o Console do Google Cloud.** As telas mudam de nome com frequência e qualquer detalhe errado gera erros pouco claros (`redirect_uri_mismatch`, `access_denied`, token que para de funcionar depois de 7 dias). Siga o [passo a passo abaixo](#configurar-o-google-cloud-reserve-1-hora) com calma. Todo o resto (SMTP, config, deploy) leva uns 15 minutos.

---

## Início rápido (sem Google, para ver funcionando)

Requer **Node 22.13+** (usa o `node:sqlite` nativo).

```bash
cd booking
npm install
cp .env.example .env
# preencha SIGNING_SECRET (gere com o comando no próprio .env) e ADMIN_KEY
npm start
# abra http://localhost:3000
```

Com `GOOGLE_CLIENT_ID` vazio, o app usa só as reservas locais. Com `SMTP_HOST` vazio, os e-mails aparecem no console. Assim dá para testar o fluxo inteiro sem nenhuma credencial.

```bash
npm test   # 9 testes: fusos/horário de verão, buffer, antecedência, fluxo reservar → reagendar → cancelar
```

## Disponibilidade: `config.json`

| Campo | Exemplo | O que faz |
|---|---|---|
| `timezone` | `America/Sao_Paulo` | Seu fuso. As regras semanais são lidas nele. |
| `weekly` | `"mon": [["10:00","17:00"]]` | Janelas por dia (`sun`…`sat`). Aceita várias por dia: `[["09:00","12:00"],["14:00","18:00"]]`. Dia vazio = fechado. |
| `meeting.durationMinutes` | `30` | Duração da reunião. |
| `slotStepMinutes` | `30` | De quanto em quanto tempo começa um horário (10:00, 10:30…). Use `15` para mais opções. |
| `bufferMinutes` | `15` | Folga obrigatória antes e depois de qualquer compromisso (reservas e eventos do Google). |
| `daysAhead` | `14` | Quantos dias para frente aparecem. |
| `minNoticeMinutes` | `240` | Antecedência mínima. Evita reservas para daqui a 10 minutos. |
| `blackoutDates` | `["2026-12-25"]` | Datas fechadas (feriados, férias). |
| `google.busyCalendars` | `["primary", "xyz@group.calendar.google.com"]` | Agendas cujos eventos bloqueiam horários. |
| `google.sendUpdates` | `"all"` | `all`: o Google também manda convite e atualizações ao visitante. `none`: só os e-mails deste app. |

O cálculo funciona assim: horário livre = janela semanal − (eventos ocupados ± buffer) − antecedência mínima. Eventos marcados como "Disponível" no Google não bloqueiam nada. Reiniciar o processo aplica as mudanças do config.

## Configurar o Google Cloud (reserve 1 hora)

1. **Projeto**: em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto (ex.: "Reservas").
2. **Ativar a API**: em *APIs e serviços → Biblioteca*, procure **Google Calendar API** e clique em *Ativar*.
3. **Tela de consentimento**: abra *APIs e serviços → Tela de permissão OAuth*. Nas versões novas do console, ela aparece como *Google Auth Platform*, com as abas *Branding*, *Público* e *Acesso a dados*.
   - Tipo de usuário: **Externo**. Use *Interno* só se for conta Google Workspace e todos forem da organização.
   - Preencha o nome do app, o e-mail de suporte e o e-mail do desenvolvedor.
   - Escopos (*Acesso a dados*): adicione `.../auth/calendar.events` e `.../auth/calendar.readonly`.
   - Usuários de teste (*Público*): adicione **o seu próprio e-mail**.
4. **⚠ Publicar o app (armadilha nº 1)**: enquanto o app fica em modo **"Teste"**, o Google **invalida o refresh token em 7 dias**. A agenda "some" uma semana depois. Em *Público*, clique em **Publicar app → Em produção**. Não precisa passar pela verificação do Google para uso pessoal: na hora de conectar aparece "O Google não verificou este app", e você clica em *Avançado → Acessar (nome do app)*. Como só você autoriza, isso basta.
5. **Credenciais**: em *Credenciais → Criar credenciais → ID do cliente OAuth*:
   - Tipo: **Aplicativo da Web**.
   - **URIs de redirecionamento autorizados**: `https://SEU-DOMINIO/auth/google/callback`. Também `http://localhost:3000/auth/google/callback` para testar localmente. O valor precisa ser **idêntico** ao `PUBLIC_URL` + `/auth/google/callback`: sem barra no fim e com o mesmo http/https. A página `/admin` mostra o valor exato a colar.
6. Copie o **Client ID** e o **Client secret** para `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env` e reinicie o app.
7. Abra `https://SEU-DOMINIO/admin?key=SUA_ADMIN_KEY` e clique em **Conectar Google Calendar**. Escolha sua conta e aceite. O refresh token fica salvo no SQLite.

**Erros comuns**

| Erro | Causa | Solução |
|---|---|---|
| `redirect_uri_mismatch` | URI no console ≠ `PUBLIC_URL/auth/google/callback` | Copie o valor exato mostrado em `/admin`. A alteração pode levar alguns minutos para valer. |
| `access_denied` / "app bloqueado" | App em teste e seu e-mail não é usuário de teste | Adicione-se como usuário de teste ou publique o app. |
| Funciona e para depois de 7 dias | App em modo "Teste" | Passo 4, depois reconecte em `/admin`. |
| "Google não devolveu refresh_token" | O Google já tinha autorizado antes | Revogue em [myaccount.google.com/permissions](https://myaccount.google.com/permissions) e conecte de novo. |
| Reserva sem link do Meet | Conta Workspace com Meet desativado pelo admin | Ative o Meet. A reserva continua valendo, só fica sem link. |

**Comportamento de segurança:** com o Google configurado mas desconectado ou falhando, a página pública **não mostra horários**. Ela prefere ficar indisponível a aceitar reserva em cima de um compromisso seu. Você recebe um e-mail de alerta (no máximo um por hora).

## SMTP (e-mails)

Exemplo com Gmail: ative a verificação em duas etapas e crie uma **senha de app** em [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=voce@gmail.com
SMTP_PASS=senha-de-app-de-16-letras
SMTP_FROM="Cristiano Medeiros <voce@gmail.com>"
OWNER_EMAIL=voce@gmail.com
```

Qualquer provedor SMTP funciona (Brevo, Resend, SES, Zoho). Em volume maior, prefira um deles ao Gmail, por causa da entregabilidade.

## Links de cancelar e reagendar

- O formato é `/b/<id>.<assinatura>`. A assinatura é um HMAC-SHA256 do id com o `SIGNING_SECRET`. Não dá para adivinhar nem alterar.
- Abrir o link de **cancelar** só mostra a confirmação. O cancelamento acontece no clique, via POST. Isso protege contra antivírus de e-mail que "abrem" os links sozinhos.
- Reagendar atualiza o mesmo evento no Google, e o Meet continua o mesmo. Os dois lados recebem e-mail com o horário antigo e o novo.
- **Trocar o `SIGNING_SECRET` invalida todos os links já enviados.**

## Rotas

| Rota | Função |
|---|---|
| `GET /` | Página pública de reservas |
| `GET /api/slots` | Horários livres (UTC, JSON) |
| `POST /book` | Cria a reserva |
| `GET /b/:token` | Confirmação e detalhes |
| `GET/POST /b/:token/reschedule` | Reagendar |
| `GET/POST /b/:token/cancel` | Cancelar (GET confirma, POST executa) |
| `GET /admin?key=…` | Status do Google, conectar/desconectar, próximas reuniões |
| `GET /health` | Monitoramento |

## Deploy

É um processo e um arquivo. Qualquer VPS (Hetzner, DigitalOcean, Lightsail) ou serviço com **disco persistente** serve: Fly.io com volume, Railway com volume. **Não use** plataformas serverless ou de disco efêmero, porque o SQLite seria apagado.

```bash
# atrás de um proxy HTTPS (Caddy faz o certificado sozinho):
#   reservas.seudominio.com { reverse_proxy localhost:3000 }
PUBLIC_URL=https://reservas.seudominio.com
TRUST_PROXY=1
```

Mantenha o processo vivo com `systemd` ou `pm2`. Para backup: `sqlite3 data/booking.db ".backup backup.db"` num cron diário.

## Estrutura

```
config.json          regras de disponibilidade
src/server.js        entrada: carrega .env, config, liga tudo
src/app.js           rotas e fluxo (reservar, reagendar, cancelar, OAuth)
src/availability.js  geração de horários (função pura, testada)
src/time.js          conversão de fuso via Intl (sem bibliotecas)
src/google.js        OAuth + Calendar REST via fetch (sem SDK)
src/mailer.js        SMTP (nodemailer) + textos dos e-mails
src/tokens.js        tokens assinados
src/db.js            SQLite (node:sqlite)
src/views.js         HTML renderizado no servidor
public/              JS e CSS da página pública
```

Dependência única: `nodemailer`.

## Limites conhecidos (decida se importam para você)

- **Quem tem o link, gerencia a reserva.** O token não expira. Se o visitante encaminhar o e-mail, quem receber pode cancelar. É o mesmo modelo do Calendly.
- **E-mails sem fila de reenvio.** Se o SMTP falhar, o erro vai para o log, mas a reserva continua confirmada e aparece no Google e em `/admin`.
- **Falha ao criar o evento no Google não desfaz a reserva.** O erro aparece em `/admin` e no seu e-mail de notificação.
- **Com `sendUpdates: "all"`, o visitante recebe dois e-mails**: o deste app (com os links de cancelar e reagendar) e o convite do Google. Mude para `"none"` se preferir só um.
- **O anti-spam é básico**: um campo invisível (honeypot) e um limite de 20 envios a cada 10 minutos por IP, em memória. Se a página virar alvo, coloque Cloudflare Turnstile no formulário.
- **Um único tipo de reunião.** Para ter vários (15 min, 60 min), o próximo passo seria transformar `meeting` em uma lista com uma rota por tipo.
