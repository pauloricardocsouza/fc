# Filadelfia — Sistema Financeiro

Sistema web de fluxo de caixa, dashboard e processamento de relatórios para Filadelfia, desenvolvido por R2 Soluções Empresariais.

## Estrutura de arquivos

```
├── index.html              # Fluxo de Caixa (página principal)
├── dashboard.html          # Dashboard com indicadores
├── lancamentos.html        # Lista de lançamentos manuais e títulos ocultados
├── comentarios.html        # Feed centralizado de comentários
├── categorias.html         # Gerenciamento de categorias de fornecedores
├── processamento.html      # Upload de relatórios SIA
├── login.html              # Tela de login
│
├── shared.css              # Estilos comuns (topbar, modais, botões)
├── fluxo.css               # Estilos da grade de fluxo
├── shared.js               # Firebase + Auth + utilitários
├── fluxo.js                # Lógica do fluxo de caixa
├── lancamentos.js          # Lógica da página de lançamentos
├── comentarios.js          # Lógica do feed de comentários
├── categorias.js           # Lógica da página de categorias
│
└── assets/
    └── logo.svg            # Logo Filadelfia (interlocking F's)
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
            ".write": "auth != null && ((data.exists() == false && newData.child('authorUid').val() === auth.uid) || (newData.exists() == false && data.child('authorUid').val() === auth.uid) || (data.exists() && newData.exists() && newData.child('authorUid').val() === data.child('authorUid').val() && newData.child('text').val() === data.child('text').val() && newData.child('createdAt').val() === data.child('createdAt').val()))",
            ".validate": "newData.hasChildren(['author', 'authorUid', 'text', 'createdAt']) && newData.child('text').isString() && newData.child('text').val().length <= 1000"
          }
        }
      },
      "lancamentos": {
        ".read": "auth != null",
        "$lancId": {
          ".write": "auth != null && (data.exists() == false || data.child('authorUid').val() === auth.uid)",
          ".validate": "newData.hasChildren(['tipo', 'entidade', 'vencimento', 'valor', 'authorUid']) && newData.child('authorUid').val() === auth.uid && newData.child('valor').isNumber() && newData.child('valor').val() > 0 && newData.child('entidade').isString() && newData.child('entidade').val().length <= 120"
        }
      },
      "deletados": {
        ".read": "auth != null",
        "$titleId": {
          ".write": "auth != null"
        }
      },
      "categorias": {
        ".read": "auth != null",
        "$categoriaId": {
          ".write": "auth != null && (data.exists() == false || data.child('nativa').val() != true || newData.child('nativa').val() === data.child('nativa').val())",
          ".validate": "newData.hasChild('nome') && newData.child('nome').isString() && newData.child('nome').val().length >= 2 && newData.child('nome').val().length <= 60"
        }
      },
      "fornecedor_categoria": {
        ".read": "auth != null",
        "$key": {
          ".write": "auth != null"
        }
      },
      "dados_importados": {
        ".read": "auth != null",
        ".write": "auth != null"
      },
      "dados_importados_meta": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

**O que essas regras fazem:**

- **Comentários:** qualquer autenticado lê; o autor pode criar, editar (mudar texto) e excluir permanentemente o próprio; qualquer autenticado pode marcar como excluído (soft-delete) ou restaurar, desde que não altere texto, autor ou data de criação. Texto limitado a 1000 caracteres.
- **Lançamentos manuais:** qualquer autenticado lê; só o autor edita/exclui o próprio. Valor precisa ser positivo, nome do fornecedor/cliente até 120 caracteres.
- **Deletados (títulos importados ocultados):** qualquer autenticado lê e edita — a operação é compartilhada entre a equipe.
- **Categorias:** qualquer autenticado cria, edita ou exclui. Categorias nativas (como "DEMAIS FORNECEDORES") não podem ser desnaturalizadas. Nome entre 2 e 60 caracteres.
- **Fornecedor → categoria:** qualquer autenticado atribui/remove categorias de fornecedores.
- **Dados importados:** qualquer autenticado lê e grava — é o payload dos relatórios SIA sincronizado entre todos os dispositivos da equipe. O nó `dados_importados_meta` é atualizado junto e contém apenas metadados leves (datas, contagens) usados para verificação rápida de versão sem baixar o payload completo.

**Importante:** em todos os casos o `authorUid` é validado contra o token de autenticação do Firebase, impedindo falsificação de identidade.

### 5. Registrar aplicativo Web

1. No console Firebase, ícone de engrenagem (⚙️) → **Configurações do projeto**
2. Role até **Seus aplicativos** → ícone de Web (</>)
3. Apelido: `Filadelfia Web`
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

### Categorias de fornecedores (novidade v2)

A partir da v2, fornecedores podem ser agrupados em categorias (ex.: Bancos, Impostos, Aluguéis, Insumos).

**Características:**

- Categorias são compartilhadas entre todos os usuários (via Firebase)
- Existe uma categoria nativa chamada **"DEMAIS FORNECEDORES"** (não pode ser excluída) que recebe automaticamente quem não está atribuído a nenhuma categoria
- Na grade de fluxo, a linha "Contas a Pagar (Total)" fica expansível: clique para ver as categorias; clique em uma categoria para ver seus fornecedores
- Fornecedores importados e de lançamentos manuais aparecem automaticamente na página de categorias
- Atribuições persistem entre importações: se você atribui "ITAU UNIBANCO" à categoria "BANCOS", a atribuição permanece mesmo depois de reimportar os relatórios

**Como usar:**

1. Acesse a página **Categorias** no menu superior
2. Crie uma nova categoria com nome e cor (ex.: BANCOS, azul)
3. Clique na categoria criada para gerenciá-la
4. A tela mostra dois painéis:
   - Esquerda: fornecedores já atribuídos a essa categoria
   - Direita: fornecedores disponíveis (não atribuídos ou em outras categorias)
5. Selecione fornecedores e use os botões **Atribuir** ou **Devolver**
6. No fluxo de caixa, clique em "Contas a Pagar (Total)" para expandir e ver os agrupamentos

### Página de Lançamentos (v2)

A página **Lançamentos** centraliza todos os lançamentos manuais e títulos ocultados da empresa. Tem três abas:

1. **Lançamentos manuais** — todos os lançamentos criados por qualquer usuário
2. **Títulos ocultados** — títulos importados que foram escondidos; podem ser restaurados por qualquer usuário
3. **Meus lançamentos** — filtro rápido só para os lançamentos que você criou

**Filtros disponíveis:** tipo (pagar/receber), autor, texto livre (fornecedor, nota, documento), período de vencimento.

**Regras de edição:**

- Qualquer usuário vê todos os lançamentos
- **Apenas o autor** pode editar ou excluir os próprios lançamentos
- Qualquer usuário pode restaurar títulos ocultados

### Página de Comentários (v2)

A página **Comentários** é um feed cronológico de todos os comentários feitos em células do fluxo, com filtros e duas abas: **Ativos** e **Excluídos**.

**Uso típico:**

1. Acesse a página **Comentários** no menu
2. Use os filtros para encontrar o que procura (ex.: comentários do Ricardo na última semana)
3. Clique em **"Ir à célula"** no card do comentário para navegar direto ao fluxo com a célula aberta
4. **Excluir** move o comentário para a aba "Excluídos" (soft-delete)
5. Na aba **Excluídos**, qualquer usuário pode clicar em **"Restaurar"** para trazer o comentário de volta
6. **Excluir permanentemente** só aparece para o autor original e apaga definitivamente do banco de dados

**Nota importante:** soft-delete significa que comentários excluídos continuam no Firebase até que alguém os apague permanentemente. Isso permite corrigir exclusões acidentais e manter um histórico de quem apagou o quê.

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

O sistema armazena no navegador **apenas** os dados importados do ERP (que são muito volumosos para sincronizar):

| Chave | Conteúdo |
|---|---|
| `filadelfia_fluxo_caixa_v2` | Relatórios importados (SIA) |
| `filadelfia_last_author` | Último autor usado |
| `filadelfia_remember_login` | Email lembrado |

**Importante:** a partir da v2, os seguintes dados passaram para o Firebase (sincronizados entre todos os usuários):

- Lançamentos manuais
- Títulos importados ocultados
- Categorias de fornecedores
- Atribuição fornecedor → categoria
- Comentários

Ou seja: um lançamento manual criado por um usuário aparece na tela dos outros imediatamente.

## Atualização da v1 para a v2

Se você já estava usando a v1 e vai atualizar:

1. **Antes de atualizar os arquivos**, pela v1 antiga, anote quaisquer lançamentos manuais importantes que queira preservar (a migração não é automática; a v2 lê do Firebase).
2. Substitua todos os arquivos HTML/CSS/JS pela v2
3. No Firebase, **atualize as regras de segurança** (aba Realtime Database → Regras) com o JSON expandido mostrado acima
4. Faça login normalmente — os comentários antigos permanecem
5. Recadastre os lançamentos manuais que quiser manter. Agora eles ficam no Firebase e todos os usuários podem ver.

## Contato

R2 Soluções Empresariais
