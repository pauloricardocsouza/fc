# Filadélfia — Sistema Financeiro

Sistema web de fluxo de caixa, dashboard e processamento de relatórios para Filadélfia, desenvolvido por R2 Soluções Empresariais.

## Estrutura de arquivos

```
├── index.html              # Fluxo de Caixa (página principal)
├── dashboard.html          # Dashboard com indicadores
├── processamento.html      # Upload de relatórios SIA
├── login.html              # Tela de login
│
├── shared.css              # Estilos comuns (topbar, modais, botões)
├── fluxo.css               # Estilos da grade de fluxo
├── shared.js               # Firebase + Auth + utilitários
├── fluxo.js                # Lógica do fluxo de caixa
│
└── assets/
    └── logo.svg            # Logo Filadélfia (interlocking F's)
```

## Configuração do Firebase

### 1. Criar projeto

1. Acesse https://console.firebase.google.com/
2. Clique em **Criar projeto**, nome sugerido: `filadelfia-financeiro`
3. Pode desabilitar Google Analytics (não é usado)

### 2. Ativar Authentication

1. Menu lateral → **Authentication** → **Começar**
2. Na aba **Sign-in method**, habilite **Email/senha**
3. Na aba **Users**, clique em **Adicionar usuário** para cada pessoa que terá acesso
   - Informe email e senha (mínimo 6 caracteres)
   - Para definir nome de exibição, após criar o usuário use o Firebase Admin SDK ou o console:
     - Na lista de usuários, clique no usuário → **Editar** → preenche o Display Name
     - Se o console não permitir editar, use a aba no Firebase Console → Authentication → Users → marque o usuário e use o menu de ações, ou configure via um script administrativo

### 3. Ativar Realtime Database

1. Menu lateral → **Realtime Database** → **Criar banco de dados**
2. Escolha a região **southamerica-east1** (São Paulo) para menor latência
3. Inicie em **modo bloqueado**

### 4. Aplicar regras de segurança

Na aba **Regras** do Realtime Database, cole o seguinte JSON:

```json
{
  "rules": {
    "filadelfia": {
      "comentarios": {
        ".read": "auth != null",
        "$cellKey": {
          "$commentId": {
            ".write": "auth != null && (!data.exists() || data.child('authorUid').val() === auth.uid)",
            ".validate": "newData.hasChildren(['author', 'authorUid', 'text', 'createdAt']) && newData.child('text').isString() && newData.child('text').val().length <= 1000 && newData.child('authorUid').val() === auth.uid"
          }
        }
      }
    }
  }
}
```

**O que essas regras fazem:**

- Apenas usuários autenticados leem os comentários
- Apenas o autor do comentário pode editá-lo ou excluí-lo
- Impede falsificação de identidade (o `authorUid` precisa bater com o UID autenticado)
- Limita texto a 1000 caracteres

### 5. Registrar aplicativo Web

1. No console Firebase, ícone de engrenagem (⚙️) → **Configurações do projeto**
2. Role até **Seus aplicativos** → ícone de Web (</>)
3. Apelido: `Filadélfia Web`
4. Copie o objeto `firebaseConfig` que aparece

### 6. Substituir credenciais no sistema

Abra o arquivo `shared.js` e substitua o bloco no topo:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",                          // Copie do Firebase
  authDomain: "filadelfia-xxx.firebaseapp.com",
  databaseURL: "https://filadelfia-xxx-default-rtdb.firebaseio.com",
  projectId: "filadelfia-xxx",
  storageBucket: "filadelfia-xxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123:web:abc123"
};
```

### 7. Definir nomes de exibição dos usuários

O Firebase não permite editar `displayName` pela interface web diretamente. Duas opções:

**Opção A (recomendada):** faça login pela primeira vez com cada conta e, na primeira interação, ajuste manualmente via console de desenvolvedor do navegador:

```javascript
firebase.auth().currentUser.updateProfile({ displayName: "Ricardo Cerqueira" })
  .then(() => console.log("Nome definido"));
```

**Opção B:** use Firebase Admin SDK pelo console na nuvem (mais técnico).

Se o usuário não tiver displayName configurado, o sistema usa a parte antes do `@` do email.

## Deploy

O sistema é 100% estático (HTML + CSS + JS). Basta subir a pasta inteira para:

- GitHub Pages (gratuito)
- Firebase Hosting
- Netlify, Vercel
- Qualquer servidor web (Apache, Nginx)

**Exemplo GitHub Pages:**

1. Crie um repositório novo (pode ser privado)
2. Suba os arquivos
3. Configurações do repositório → Pages → Branch main / root
4. Adicione o domínio `dash.solucoesr2.com.br` (se configurado no DNS)

## Segurança — Checklist

✅ **Sanitização HTML:** toda inserção de dados do usuário no DOM passa por `F.escapeHTML`. Nunca é feito `innerHTML = userData` diretamente.

✅ **XSS:** atributos `title=`, `data-*` também são escapados.

✅ **Regras Firebase:** apenas autor modifica próprio comentário, autenticação obrigatória.

✅ **Validação de input:**
- Lançamentos manuais: limite de caracteres em nome (120), observação (500), comentário (1000).
- Valores numéricos validados antes de salvar.

✅ **Storage quota:** `Storage.safeSetItem` detecta `QuotaExceededError` e notifica o usuário.

✅ **Feriados corretos:** cálculo automático de Páscoa (algoritmo Anonymous Gregorian) para Carnaval, Sexta-feira Santa e Corpus Christi.

✅ **Nenhum segredo hardcoded:** `firebaseConfig.apiKey` é pública por design (é protegida pelas regras do banco).

✅ **Auth guard:** todas as páginas protegidas chamam `F.Auth.requireAuth()` antes de renderizar.

## Uso diário

### Importação de relatórios (semanal / mensal)

1. No ERP SIA, exporte:
   - **Contas a Pagar → Consulta Analítica por Título**
   - **Contas a Receber → Consulta Analítica por Título**
2. No sistema, vá em **Processamento**
3. Arraste os dois arquivos
4. Clique em **Processar e salvar**
5. O sistema usa automaticamente o **período em comum** entre os dois arquivos
6. Os lançamentos manuais e a lixeira são preservados; apenas os títulos importados são substituídos

### Navegação

- **Fluxo de Caixa** (`index.html`): grade diária por fornecedor
- **Dashboard** (`dashboard.html`): indicadores estratégicos
- **Processamento** (`processamento.html`): upload dos relatórios

### Regras bancárias aplicadas

- **Contas a Pagar:** se o vencimento cai em fim de semana ou feriado, a data efetiva é o próximo dia útil
- **Contas a Receber:** cliente paga no próximo dia útil a partir do vencimento; o valor compensa no dia útil seguinte (D+1)

Você pode alternar entre "Data efetiva" e "Vencimento" no topo da grade.

### Dashboard — Indicadores disponíveis

- **KPIs:** total a receber, total a pagar, saldo líquido, cobertura de caixa (%)
- **Distribuição de dias:** positivos / negativos / neutros
- **Evolução acumulada:** gráfico de linha do saldo projetado
- **Top 10 Fornecedores:** valor a pagar + concentração em barra
- **Top 10 Clientes:** valor a receber
- **Concentração de risco:** % dos top 3 fornecedores sobre o total
- **Movimento por dia da semana:** média de entradas e saídas por weekday
- **Dias críticos:** os 3 maiores deficits e 2 maiores superavits
- **Resumo numérico:** médias, máximos, contadores

### Períodos disponíveis

- Próximos 7 dias (padrão)
- Próximos 14 dias
- Próximos 21 dias
- Personalizado (calendário)

## Armazenamento local (localStorage)

O sistema armazena no navegador:

| Chave | Conteúdo |
|---|---|
| `filadelfia_fluxo_caixa_v2` | Relatórios importados |
| `filadelfia_provisoes_v1` | Lançamentos manuais |
| `filadelfia_deleted_imp_v1` | Títulos importados ocultados |
| `filadelfia_trash_v1` | Lixeira |
| `filadelfia_last_author` | Último autor usado |
| `filadelfia_remember_login` | Email lembrado |

**Os dados ficam apenas no dispositivo do usuário.** Apenas os comentários são sincronizados via Firebase.

## Contato

R2 Soluções Empresariais
