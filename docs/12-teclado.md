# 12 — Jogar só com o teclado

Roteiro de verificação da Fase 3 do [plano 10](10-plano-redesign-ux.md) (§6, "Tabuleiro
2.1.1/4.1.2"): **uma partida inteira, do zero ao fim, sem tocar no mouse**.

Serve para dois usos: conferir a acessibilidade depois de qualquer mudança na interface e
ensinar os atalhos a quem prefere teclado. Tudo aqui vale igual para o tema claro e o
escuro, no desktop e no celular com teclado físico.

---

## 1. Mapa de teclas

### Em qualquer lugar da página
| Tecla | O que faz |
|---|---|
| `Tab` / `Shift+Tab` | anda pelos controles. O tabuleiro inteiro é **uma** parada de tabulação |
| `←` `→` | lance anterior / próximo (modo revisão) |
| `Home` | posição inicial |
| `End` | volta ao vivo |
| `Esc` | fecha diálogo, popover ou cancela a seleção no tabuleiro |

`←` `→` `Home` `End` são ignorados quando o foco está num campo de texto, na grade do
tabuleiro ou nas abas do Caderno — cada um desses tem uso próprio para as setas.

### Dentro do tabuleiro (`role="grid"`, 64 casas)
| Tecla | O que faz |
|---|---|
| `←` `↑` `→` `↓` | move a casa ativa (acompanha a orientação: com as pretas embaixo, `↑` sobe na tela) |
| `Home` / `End` | primeira / última coluna da fileira atual |
| letra `a`–`h` e depois número `1`–`8` | pula direto para a casa (ex.: `e` `4` → e4) |
| `Enter` ou `Espaço` | seleciona a peça; na segunda vez, joga para a casa ativa |
| `Esc` | cancela a seleção |

Cada casa se anuncia como `"e4, peão branco"` / `"e5, vazia"`, e acrescenta
`"selecionada"`, `"destino possível"`, `"captura possível"`, `"em xeque"` e `"último lance"`
quando for o caso.

### Nas abas do Caderno
| Tecla | O que faz |
|---|---|
| `←` `→` | troca de aba (Aula / Lances / Ações) |
| `Enter` | ativa a aba com foco |

### No campo de mensagem
| Tecla | O que faz |
|---|---|
| `Enter` | envia |
| `Shift+Enter` | quebra a linha |

---

## 2. Regiões que falam sozinhas

Duas regiões `aria-live="polite"` existem desde o primeiro render, **vazias**, e só o texto
dentro delas muda — é o que faz o leitor de tela anunciar (o erro 4.1.3 do diagnóstico era
justamente mover o atributo para um nó novo):

| Região | Conteúdo |
|---|---|
| `#sr-moves` | `"Felipe jogou peão e4. Claude está pensando."`, `"Claude jogou cavalo f3, xeque. Sua vez."`, fim de partida |
| `#sr-comments` | `"Claude, atenção: meu bispo de f6 e o cavalo de e7 vigiam d5. Desenho no tabuleiro: seta azul de f6 para d4…"` |

O desenho que acompanha um comentário (setas e casas) vai descrito em texto nas duas
regiões e também dentro do cartão do comentário, em texto oculto.

---

## 3. Roteiro de teste

Faça na ordem, **sem usar o mouse**. Entre parênteses, o que precisa acontecer.

### (a) Abrir e conectar
1. `localhost:3939` (ou `?mock=waiting` para testar sem servidor).
2. `Tab` até "Conectar IA" no cabeçalho. (o painel de passos já está na coluna da direita;
   o passo 1 está ✓ se o servidor responde)
3. `Tab` pelos chips "Claude Code / Claude Desktop / Outro" e `Enter` num deles.
   (o comando muda; o botão "Copiar" fica a um `Tab`)
4. `Tab` até "Copiar" e `Enter`. (o botão vira "✓ Copiado")

### (b) Nova partida
5. `Tab` até "Nova partida" e `Enter`. (abre um `<dialog>`; o foco cai **dentro** dele e o
   resto da página fica inerte)
6. `↓` / `Tab` entre os modos, `Espaço` para escolher, `Tab` até "Começar", `Enter`.
7. `Esc` em vez de "Começar" também fecha — e o foco volta para "Nova partida".

### (c) Cinco lances
8. `Tab` até o tabuleiro. (uma única parada; a casa ativa recebe contorno de foco)
9. `e` `2` → `Enter` → `↑` `↑` → `Enter`. (peão vai de e2 a e4; `#sr-moves` anuncia
   "Você jogou peão e4")
10. Repita para mais quatro lances. Numa promoção, o `<dialog>` de promoção abre com o
    foco na Dama; `Tab` escolhe outra peça, `Esc` cancela.
11. Em qualquer momento, `Esc` cancela uma seleção.

### (d) Lance recusado
12. Tente jogar fora da vez (ou com o servidor parado). (a peça **volta animada** para a
    casa de origem — o tabuleiro não é remontado — e aparece um aviso com `role="alert"`,
    que fica 10 s, pausa se receber foco e tem botão "Fechar" alcançável por `Tab`)

### (e) Revisar
13. Com o foco **fora** do tabuleiro, `←` algumas vezes. (a moldura fica em "papel", com
    o rótulo "Revisando 3… ♞c6"; o tabuleiro perde a sombra; o Caderno rola até o
    comentário daquele lance e o destaca; o desenho daquele comentário reaparece)
14. `Home` vai ao começo, `End` volta ao vivo.
15. Se chegar lance novo durante a revisão, o botão "voltar ao vivo" ganha "+1" e o texto
    oculto "1 lance novo ao vivo". Nada muda no tabuleiro sem você mandar.

### (f) Caderno
16. `Tab` até as abas, `→` para "Lances". (a tabela aparece; `Tab` chega aos botões de
    navegação ⏮ ◀ ▶ ⏭)
17. `→` de volta para "Aula", `Tab` até o campo de mensagem, escreva e `Enter`.

### (g) Desistir e cancelar
18. `Tab` até "Desistir" e `Enter`. (abre um `popover` ancorado ao botão; o foco vai para
    **"Cancelar"**, não para a ação destrutiva)
19. `Esc`. (fecha e devolve o foco a "Desistir"; nada acontece com a partida)

### (h) Fim de partida
20. Ao terminar, o banner aparece sobre a mesa com "Revisar", "PGN" e "Nova partida", todos
    alcançáveis por `Tab`, e `#sr-moves` anuncia o resultado.

---

## 4. O que foi verificado automaticamente

Com Playwright + axe-core (`wcag2a`, `wcag2aa`, `wcag21a/aa`, `wcag22aa`, `best-practice`),
nos oito cenários de `?mock=…`, em tema claro e escuro, e com o diálogo e o popover abertos:
**zero violações**, inclusive nenhuma `critical`/`serious`.

Também medido no navegador:

- o tabuleiro tem **uma** parada de tabulação (`[tabindex="0"]` = 1 dentro de `.board-wrap`);
- as 64 casas têm `role="gridcell"` e `aria-label`;
- lance por teclado (`e2` → `Enter` → `↑↑` → `Enter`) muda a posição no servidor real e é
  anunciado em `#sr-moves`;
- lance recusado (HTTP 409) devolve a peça sem remontar o tabuleiro e mostra `role="alert"`.

> Nota: o react-chessboard embrulha cada peça num `div[role="button"][tabindex="0"]` do
> dnd-kit, sem nome acessível — 27 paradas de tabulação anônimas e um atalho de arrastar em
> inglês. Como a biblioteca não deixa desligar isso, o `Board` mantém um `MutationObserver`
> que limpa esses atributos assim que aparecem. Se a lib for atualizada, confira se o
> seletor `[aria-roledescription="draggable"]` continua valendo.

## 5. O que ainda depende de teste manual

Leitor de tela de verdade (NVDA no Windows, VoiceOver no macOS) não foi executado: axe
confere a marcação, não a fala. Ao rodar, confirme que (1) cada lance é anunciado uma vez
só, (2) o comentário é lido inteiro e (3) o anúncio da casa não atropela o do lance.
