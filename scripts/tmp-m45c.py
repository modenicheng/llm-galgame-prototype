import io, re

with io.open('src/game.ts', 'r', encoding='utf-8', newline='') as f:
    lines = f.read().replace('\r\n', '\n').split('\n')

# find current line numbers of the second-batch methods
targets = ['buildRuntimeInteraction', 'consumePlayableEvents', 'consumeLiveSelection',
           'consumeLiveInputResponse', 'consumeLiveStream']
found = {}
for i, ln in enumerate(lines, 1):
    for name in targets:
        if name not in found and re.match(r'^  (async )?%s\(' % name, ln):
            found[name] = i
print(found)

def find_block(start_line):
    s = start_line - 1
    while s > 0 and (lines[s-1].strip().startswith('//') or lines[s-1].strip() == ''):
        s -= 1
    depth = 0
    seen = False
    e = s
    while e < len(lines):
        depth += lines[e].count('{') - lines[e].count('}')
        if '{' in lines[e]:
            seen = True
        if seen and depth <= 0:
            return s, e
        e += 1
    return s, len(lines) - 1

blocks = []
for name in targets:
    s, e = find_block(found[name])
    blocks.append((name, s, e))

driver_names = set(targets) | {'resolveInteraction','createBranchManagerForTerminal','startBridgePrefetch',
    'cancelBridgePrefetch','adoptSelectedBranch','handleChoice','createBranchManager','handleInteractionInput',
    'startInputResponseGeneration','stageResponseEvent','makePlayerDialogue','handleHybridInteraction',
    'countBufferedDialogues','recordPlayerChoice','recordPlayerInput','recordPlayerDialogue'}

moved_texts = []
for name, s, e in blocks:
    body = '\n'.join(lines[s:e+1])
    def repl(m):
        ident = m.group(1)
        if ident in driver_names:
            return m.group(0)
        return 'this.host.' + ident
    body = re.sub(r'this\.([A-Za-z_][A-Za-z0-9_]*)', repl, body)
    body = re.sub(r'^  private (async )?', '  ', body, flags=re.M)
    moved_texts.append(body)

# append to driver class: insert before final '}\n' of the file
p = 'src/runtime/interaction-driver.ts'
with io.open(p, 'r', encoding='utf-8', newline='') as f:
    dt = f.read().replace('\r\n', '\n')
addition = '\n  // -----------------------------------------------------------------\n  // live 消费与运行时交互构造（M4.5 第二批）\n  // -----------------------------------------------------------------\n\n  ' + '\n\n  '.join(moved_texts) + '\n'
dt = dt.rstrip('\n')
dt = dt[:dt.rindex('}')] + addition + '}\n'
write_driver = dt
with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(write_driver.replace('\n', '\r\n'))
print('driver appended')

# remove from game.ts (bottom-up)
for name, s, e in sorted(blocks, key=lambda b: -b[2]):
    e2 = e
    while e2 < len(lines) - 1 and lines[e2].strip() == '':
        e2 += 1
    del lines[s - 1:e2]
t = '\n'.join(lines)
for name in targets:
    t = t.replace(f'this.{name}(', f'this.interactionDriver.{name}(')
write('src/game.ts', t)
print('game.ts batch 2 removed')
