import io, re

p = 'src/game.ts'
with io.open(p, 'r', encoding='utf-8', newline='') as f:
    lines = f.read().replace('\r\n', '\n').split('\n')

# moved method start lines (1-based) from grep
starts = {
    'resolveInteraction': 1072,
    'createBranchManagerForTerminal': 1254,
    'startBridgePrefetch': 1344,
    'cancelBridgePrefetch': 1403,
    'adoptSelectedBranch': 1435,
    'handleChoice': 1519,
    'createBranchManager': 1891,
    'handleInteractionInput': 2005,
    'startInputResponseGeneration': 2232,
    'stageResponseEvent': 2333,
    'makePlayerDialogue': 2348,
    'handleHybridInteraction': 2361,
    'countBufferedDialogues': 2523,
    'recordPlayerChoice': 2529,
    'recordPlayerInput': 2543,
    'recordPlayerDialogue': 2561,
}
# order by line, end = next method start after it (approx; doc comments move along)
ordered = sorted(starts.items(), key=lambda kv: kv[1])

# find each method's true start (walk back over doc comments) and end (brace balance)
def find_block(start_line):
    s = start_line - 1  # 0-based
    # walk back over comments/blanks
    while s > 0 and (lines[s-1].strip().startswith('//') or lines[s-1].strip() == ''):
        s -= 1
    # forward to brace-balanced end
    depth = 0
    seen = False
    e = s
    while e < len(lines):
        depth += lines[e].count('{') - lines[e].count('}')
        if '{' in lines[e]:
            seen = True
        if seen and depth <= 0:
            return s, e  # inclusive
        e += 1
    return s, len(lines) - 1

blocks = []
for name, ln in ordered:
    s, e = find_block(ln)
    blocks.append((name, s, e))

# merge overlapping/adjacent and compute host refs
moved_names = set(starts.keys())
host_refs = {}
driver_refs = {}
total = 0
for name, s, e in blocks:
    total += e - s + 1
    body = '\n'.join(lines[s:e+1])
    for m in re.finditer(r'this\.([A-Za-z_][A-Za-z0-9_]*)', body):
        ident = m.group(1)
        if ident in moved_names:
            driver_refs[ident] = driver_refs.get(ident, 0) + 1
        else:
            host_refs[ident] = host_refs.get(ident, 0) + 1

print('total moved lines:', total)
print('\n== HOST members used ==')
for k, v in sorted(host_refs.items()):
    print(f'{k}: {v}')
print('\n== driver-internal ==')
for k, v in sorted(driver_refs.items()):
    print(f'{k}: {v}')
print('\n== block ranges (0-based inclusive) ==')
for name, s, e in blocks:
    print(name, s+1, e+1)

# save ranges for the rewrite script
with io.open('scripts/_ranges.txt', 'w') as f:
    for name, s, e in blocks:
        f.write(f'{name} {s} {e}\n')
