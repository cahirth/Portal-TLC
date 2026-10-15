# Portal TLC | tools/generar_guia_tutoriales.py | v2026.10.15.2 (incluye TITULOS de tutorial.js para el índice del manual)
# (v2026.10.15.1: versión inicial)
# Arma tutoriales/Portal-TLC-Tutoriales.html: la misma página que tutoriales.html
# pero con TODAS las imágenes adentro (base64, achicadas a 720 px), para mandarla
# por mail o WhatsApp y abrirla sin internet.
#
# - La lista de módulos e imágenes sale de tutorial.js (SETS): es la única fuente.
# - Solo regenera si cambió algo (imágenes, tutorial.js, tutoriales.html o este
#   script): guarda una huella en el archivo y la compara. Así la GitHub Action
#   (.github/workflows/guia-tutoriales.yml) no hace commits de más.
#
# Uso (desde la raíz del repo):  python tools/generar_guia_tutoriales.py
# Requiere: pip install pillow
import base64, datetime, hashlib, io, json, os, re, sys
from PIL import Image

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'tutoriales', 'Portal-TLC-Tutoriales.html')
ANCHO, ALTO, CALIDAD = 720, 900, 80


def leer(p, modo='r'):
    with open(os.path.join(RAIZ, p), modo, **({} if 'b' in modo else {'encoding': 'utf-8'})) as f:
        return f.read()


def sets_de_tutorial_js():
    js = leer('tutorial.js')
    bloque = js[js.index('var SETS = {'):]
    bloque = bloque[:bloque.index('};')]
    sets = {}
    for m in re.finditer(r"^\s*'?([\w-]+)'?\s*:\s*\{\s*titulo:\s*'([^']*)',\s*slides:\s*\[([^\]]*)\]", bloque, re.M):
        sets[m.group(1)] = {'titulo': m.group(2), 'slides': re.findall(r"'([^']+)'", m.group(3))}
    if not sets:
        sys.exit('No se encontraron SETS en tutorial.js')
    return sets


def titulos_de_tutorial_js():
    js = leer('tutorial.js')
    if 'var TITULOS = {' not in js:
        return {}
    bloque = js[js.index('var TITULOS = {'):]
    bloque = bloque[:bloque.index('};')]
    return {m.group(1): m.group(2).replace("\\'", "'") for m in re.finditer(r"^\s*'([\w-]+)'\s*:\s*'((?:[^'\\]|\\.)*)'", bloque, re.M)}


def main():
    sets = sets_de_tutorial_js()
    titulos = titulos_de_tutorial_js()
    plantilla = leer('tutoriales.html')
    nombres = sorted({s for v in sets.values() for s in v['slides']})
    faltan = [n for n in nombres if not os.path.exists(os.path.join(RAIZ, 'tutoriales', n + '.jpg'))]
    if faltan:
        sys.exit('Faltan imágenes en tutoriales/: ' + ', '.join(faltan))

    h = hashlib.sha256()
    h.update(json.dumps([sets, titulos], sort_keys=True).encode())
    h.update(plantilla.encode())
    h.update(leer('tools/generar_guia_tutoriales.py').encode())
    for n in nombres:
        h.update(n.encode()); h.update(leer('tutoriales/' + n + '.jpg', 'rb'))
    huella = h.hexdigest()[:16]

    if os.path.exists(SALIDA):
        with open(SALIDA, encoding='utf-8') as f:
            if ('huella:' + huella) in f.read(400):
                print('Sin cambios (huella ' + huella + ').')
                return

    imgs = {}
    for n in nombres:
        im = Image.open(os.path.join(RAIZ, 'tutoriales', n + '.jpg')).convert('RGB').resize((ANCHO, ALTO), Image.LANCZOS)
        b = io.BytesIO(); im.save(b, 'JPEG', quality=CALIDAD, optimize=True, progressive=True)
        imgs[n] = 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()

    fecha = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3))).strftime('%d/%m/%Y')
    datos = 'window.TUT_OFFLINE = ' + json.dumps({'sets': sets, 'titulos': titulos, 'imgs': imgs, 'fecha': fecha}, ensure_ascii=False) + ';'
    html = re.sub(r'<!--OFFLINE-QUITAR-->.*?<!--/OFFLINE-QUITAR-->', '', plantilla, flags=re.S)
    html = html.replace('<link rel="manifest" href="manifest.json">\n', '')
    html = html.replace('/*OFFLINE-DATOS*/', datos)
    html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- Portal TLC | Portal-TLC-Tutoriales.html | ARCHIVO GENERADO por tools/generar_guia_tutoriales.py — no editar a mano. huella:' + huella + ' -->', 1)
    with open(SALIDA, 'w', encoding='utf-8') as f:
        f.write(html)
    print('Generado %s (%d imágenes, %.1f MB, huella %s)' % (os.path.relpath(SALIDA, RAIZ), len(imgs), os.path.getsize(SALIDA) / 1048576, huella))


if __name__ == '__main__':
    main()
