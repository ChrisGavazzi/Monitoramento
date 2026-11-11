# Como as telas funcionam por dentro

Para quem quer mudar o visual, um limite ou uma regra de alguma tela. Para usar o kit, não precisa ler isto.

## Cada tela é JavaScript num painel Business Text

O painel *Business Text* do Grafana aceita um código *After Render*. O plugin do Zabbix entrega o resultado das
consultas como *data frames*, e o código monta HTML/SVG a partir deles. As consultas são poucas e largas, por
grupo de hosts e por nome de item, e o JavaScript faz o cruzamento.

| Consulta | Traz |
|---|---|
| `A` | disponibilidade (ping, SNMP, agente), internet de cada link, túnel |
| `N` | servidores da nuvem (no mapa) |
| `I` / `R` / `P` | interfaces de roteadores e switches: estado, tráfego, velocidade, erros |
| `S`, `S1…Sn` | sistema do roteador (CPU, memória...) ou uma categoria de equipamentos por seção |
| `L` | hosts `LINK-*` (ping do IP público e do gateway da operadora) |
| `F` | problemas atuais |
| `T` | texto (o JSON do coletor de VPN) |

## Onde fica cada coisa

```
modelos/<tela>.json             layout do dashboard (painéis, tamanhos, consultas-base), sem código
modelos/codigo/<tela>/painel-N.js   código do painel N
modelos/codigo/<tela>/painel-N.css  estilo do painel N
modelos/codigo/comum/cabecalho.*    cabeçalho (painel 900), o mesmo em todas as telas
```

O `noc.py gerar` junta tudo:
1. copia o layout de cada tela;
2. troca as consultas pelos grupos e hosts do site;
3. coloca antes do código de cada painel uma linha `const NOC = {...}` com o que a tela precisa saber do `noc.yaml`;
4. grava em `saida/grafana/`.

O que vai no `NOC`:

| Campo | Conteúdo |
|---|---|
| `empresa`, `grupo`, `tela` | nome da empresa, site atual (ou `nuvem`), UID da tela |
| `telas`, `sites`, `nuvem` | abas e botões do cabeçalho |
| `hosts`, `tipos`, `rotulos`, `ips` | host → site, host → tipo, rótulo de câmera, IP de servidor |
| `topo`, `mapa_nuvem` | topologia do mapa (nós, ligações, áreas, câmeras) e bloco da nuvem |
| `links`, `links_uid` | links do site (roteador, interface, banda) para as telas de links |
| `cfg` | seções da visão geral e da tela de equipamentos |

## Mudar uma tela

1. Edite `modelos/codigo/<tela>/painel-N.js` (ou `.css`). Os limites ficam em constantes no começo, por exemplo `UTIL_ATENCAO = 70`.
2. `python noc.py gerar` e `python tools/demo.py` para ver o resultado sem Grafana.
3. Reimporte a tela no Grafana.

Também dá para editar direto no Grafana (*Edit → After Render*), mas a próxima geração sobrescreve. Leve a mudança
para o arquivo em `modelos/codigo/`.

## Regras que valem para todas as telas

- **Sem visibilidade não é fora.** Túnel até o site fora = os valores do site são velhos. As telas pintam de cinza, com a causa, em vez de vermelho.
- **Tudo na tela concorda no tempo.** A disponibilidade é avaliada pelo histórico recente, não só pelo último valor. Depois que o túnel volta, há 2 minutos de carência ("atualizando") antes de mostrar vermelho.
- **Um alerta, não sessenta.** A mesma topologia do mapa gera as dependências de trigger no Zabbix (`noc.py dependencias`).
