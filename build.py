import re
a=open('src/app.html').read(); e=open('src/engine.js').read(); x=open('src/exporter.js').read(); o=open('src/ocr.js').read()
# strip debug hooks
e=re.sub(r'\n\s*if \((typeof globalThis[^)]*\)|globalThis\.__DBG\d?)\)[^\n]*', '', e)
assert '</script' not in e and '</script' not in x
open('index.html','w').write(a.replace('/*ENGINE*/',e).replace('/*EXPORTER*/',x).replace('/*OCR*/',o))
print('ok', len(open('index.html').read())//1024,'KB')
