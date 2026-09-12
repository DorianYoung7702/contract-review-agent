/**
 * Minimal YAML subset parser for playbook files (maps/lists/scalars only).
 * Avoids adding an external dependency for phase-1 constrained YAML.
 */

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function indentOf(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseYaml(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim() && !line.trim().startsWith('#'));

  let index = 0;

  function parseBlock(minIndent) {
    const obj = {};
    let list = null;

    while (index < lines.length) {
      const line = lines[index];
      const indent = indentOf(line);
      if (indent < minIndent) break;

      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        if (!list) list = [];
        const rest = trimmed.slice(2).trim();
        index += 1;
        if (!rest.includes(':')) {
          list.push(parseScalar(rest));
          continue;
        }
        // list item is a map
        const item = {};
        const [k, ...restParts] = rest.split(':');
        const key = k.trim();
        const inline = restParts.join(':').trim();
        if (inline) {
          item[key] = parseScalar(inline);
        } else {
          item[key] = parseBlock(indent + 2);
        }
        // continue reading sibling keys of this list item
        while (index < lines.length) {
          const next = lines[index];
          const nextIndent = indentOf(next);
          if (nextIndent <= indent) break;
          if (next.trim().startsWith('- ')) break;
          const nt = next.trim();
          const colon = nt.indexOf(':');
          if (colon < 0) {
            index += 1;
            continue;
          }
          const nk = nt.slice(0, colon).trim();
          const nv = nt.slice(colon + 1).trim();
          index += 1;
          item[nk] = nv ? parseScalar(nv) : parseBlock(nextIndent + 2);
        }
        list.push(item);
        continue;
      }

      if (list) {
        // finished list at this level
        break;
      }

      const colon = trimmed.indexOf(':');
      if (colon < 0) {
        index += 1;
        continue;
      }
      const key = trimmed.slice(0, colon).trim();
      const valuePart = trimmed.slice(colon + 1).trim();
      index += 1;
      if (valuePart) {
        obj[key] = parseScalar(valuePart);
      } else {
        obj[key] = parseBlock(indent + 2);
      }
    }

    return list || obj;
  }

  return parseBlock(0);
}

module.exports = { parseYaml };
