import io


def patch(path, old, new, count=1):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        t = f.read()
    for a, b in ((old, new), (old.replace('\n', '\r\n'), new.replace('\n', '\r\n'))):
        if a in t:
            t = t.replace(a, b, count)
            with io.open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(t)
            print('patched', path)
            return
    raise AssertionError((path, old[:70]))


v = 'src/application/narrative/memory-validator.test.ts'
PAYOFF = 'payoff: "The key opens the hidden drawer",'

# 647 site: already has 50, add payoff field to expected
patch(
    v,
    'expect(classifySetup(item, 10, "anchor-x", true, 50)).toEqual({\n      id: "setup-1",\n      action: "payoff",\n      urgency: "now",\n      premise: "The brass key under the floorboard",\n    });',
    'expect(classifySetup(item, 10, "anchor-x", true, 50)).toEqual({\n      id: "setup-1",\n      action: "payoff",\n      urgency: "now",\n      premise: "The brass key under the floorboard",\n      ' + PAYOFF + '\n    });',
    2,
)

# 662 loop site: add 50 + payoff field
patch(
    v,
    'expect(classifySetup(item, 10, "anchor-x", true)).toEqual({\n      id: "setup-1",\n      action: "payoff",\n      urgency: "now",\n      premise: "The brass key under the floorboard",\n    });',
    'expect(classifySetup(item, 10, "anchor-x", true, 50)).toEqual({\n      id: "setup-1",\n      action: "payoff",\n      urgency: "now",\n      premise: "The brass key under the floorboard",\n      ' + PAYOFF + '\n    });',
)

# scheduler: add payoff field to expected
patch(
    'src/application/narrative/setup-scheduler.test.ts',
    'expect(directives[0]).toEqual({\n      id: "s1", action: "payoff", urgency: "now", premise: "终端对苏遥异常响应",\n    });',
    'expect(directives[0]).toEqual({\n      id: "s1", action: "payoff", urgency: "now", premise: "终端对苏遥异常响应", payoff: "揭示终端的秘密",\n    });',
)
