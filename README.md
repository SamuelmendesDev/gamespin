# 🎮 SteamSpin — Desktop

App Electron para sortear e lançar jogos da sua biblioteca Steam.

## Requisitos

- [Node.js](https://nodejs.org/) v18 ou superior

## Instalação e uso

```bash
# 1. Entre na pasta do projeto
cd steamspin-electron

# 2. Instale as dependências (só na primeira vez)
npm install

# 3. Inicie o app
npm start
```

## Na primeira abertura

1. Cole sua **Steam API Key** — obtenha em https://steamcommunity.com/dev/apikey
2. Cole seu **Steam ID** (64-bit) — descubra em https://steamid.io
3. Clique em **Procurar** ou **Auto** para localizar a pasta do Steam
4. Clique em **CONECTAR**

Seu perfil Steam precisa estar **público**:
Steam → Configurações → Privacidade → Detalhes do jogo → **Público**

## Funcionalidades

- 📚 Biblioteca completa com capas, tempo jogado e status de instalação
- 🎲 Sorteio aleatório (tecla `Espaço`)  
- 🏷️ Filtros por gênero na sidebar (seleção múltipla)
- 🔍 Busca por nome + ordenação
- ▶️ **Botão Jogar** — abre o jogo direto pelo Steam se instalado
- ⬇️ **Botão Instalar** — abre a Steam Store para instalar se não tiver
- ✅ Badge "INSTALADO" nos cards dos jogos que você tem no PC
- ⚡ Cache em disco — gêneros e detalhes salvos por 7 dias
- 🔄 Botão ↻ para atualizar a biblioteca

## Estrutura

```
steamspin-electron/
├── package.json
├── src/
│   ├── main.js       # Processo principal Electron (Node.js)
│   ├── preload.js    # Bridge segura IPC
│   ├── index.html    # Interface
│   ├── style.css     # Estilos
│   └── app.js        # Lógica do frontend
└── assets/
    └── icon.png      # (opcional) ícone do app
```

## Atalhos de teclado

| Tecla | Ação |
|-------|------|
| `Espaço` | Sortear jogo aleatório |
| `Esc` | Fechar modal |

## Para gerar um .exe depois

```bash
npm install --save-dev electron-builder
npx electron-builder --win --dir
```
