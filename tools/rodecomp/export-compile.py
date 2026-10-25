"""Convert CMake's compile_commands.json to the upstream Clank compile schema.
Run after configuring with the container's MSVC/Wine toolchain.
"""
import argparse
import json
import pathlib
import shlex

parser = argparse.ArgumentParser()
parser.add_argument('commands')
parser.add_argument('output')
parser.add_argument('--source', required=True)
parser.add_argument('--toolchain', default='/opt/toolchain')
parser.add_argument('--compiler', required=True)
parser.add_argument('--include', required=True, help='Semicolon-separated MSVC/SDK include paths')
args = parser.parse_args()
source = pathlib.Path(args.source).resolve()

def replace(value):
    return value.replace('Z:' + str(source).replace('/', '\\'), '${SRC}').replace(str(source), '${SRC}').replace('Z:' + args.toolchain.replace('/', '\\'), '${TC}').replace(args.toolchain, '${TC}')

shapes, units = [], {}
for row in json.loads(pathlib.Path(args.commands).read_text()):
    file = pathlib.Path(row['file']).resolve().relative_to(source).as_posix()
    command = row.get('arguments') or shlex.split(row['command'])
    # CMake's compiler launcher may precede cl.exe.
    compiler_index = next(i for i, arg in enumerate(command) if arg.lower().endswith(('cl.exe', 'cl-wine.sh')))
    flags = []
    skip = False
    for arg in command[compiler_index + 1:]:
        if skip:
            skip = False
            continue
        if arg in ('-o', '-MF', '-MT'):
            skip = True
            continue
        if arg.lower().startswith(('/fo', '/fd', '/fa')) or arg in ('/showIncludes',):
            continue
        if arg.replace('\\', '/').removeprefix('Z:') == str(pathlib.Path(row['file']).resolve()):
            continue
        flags.append(replace(arg))
    if '/c' not in flags and '-c' not in flags:
        flags.append('/c')
    if flags not in shapes:
        shapes.append(flags)
    units[file] = shapes.index(flags)
result = {'compiler': replace(args.compiler), 'env': {'INCLUDE': replace(args.include)}, 'shapes': shapes, 'units': dict(sorted(units.items()))}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(f'Exported {len(units)} units in {len(shapes)} compile shapes')
