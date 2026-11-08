"""Extract downloaded public FAA/ALSSA glossary data. No inference or game mutation."""
import hashlib,html,json,re
from pathlib import Path
import pdfplumber

root=Path(__file__).resolve().parents[1]
cache=root/'.game-server/aviation-import'
def plain(value):
 return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]*>',' ',value))).strip()
def key(source,url):
 return source+'-'+hashlib.sha256(url.encode()).hexdigest()[:16]
entries=[]
for file in sorted(cache.glob('faa-?.html')):
 source=file.read_text('utf8');starts=list(re.finditer(r'<p\b[^>]*class="[^"]*\bglossary-term-entry\b[^"]*"[^>]*>',source))
 for i,m in enumerate(starts):
  block=source[m.start():starts[i+1].start() if i+1<len(starts) else source.index('</main>',m.start()) if '</main>' in source[m.start():] else len(source)]
  title=re.search(r'<dfn\b[^>]*>(.*?)</dfn>',block,re.S)
  anchor=re.search(r'\bid="([^"]+)"',m.group())
  if title:
   name=plain(title.group(1)).rstrip(' -–‐−')
   definition=plain(block[title.end():]).lstrip(' -–‐−')
  else:
   text=plain(block);split=re.match(r'^(.{1,220}?)(?:[-‐]\s+|[–−—]\s*)(.+)$',text) or re.match(r'^(.{1,180}?)\s+\(?(See\b.*)$',text)
   if not split:raise ValueError('Missing FAA term boundary: '+file.name+' '+text[:250])
   name,definition=split.groups()
  # The final term is followed by page navigation, which is not part of its definition.
  definition=re.split(r'(?:Previous Section|Back to Top|Next Section|Pilot/Controller Glossary by)',definition)[0].strip()
  url='https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/glossary-'+file.stem[-1]+'.html'+('#'+anchor.group(1) if anchor else '')
  entries.append(dict(id=key('faa',url+'|'+name),term=name,source='faa',url=url,definition=definition[:2600]))
print('FAA extracted',len(entries),flush=True)

pdf_file=cache/'brevity_2025.pdf'
if pdf_file.exists():
 with pdfplumber.open(pdf_file) as pdf:
  pending=None
  for page_number,page in enumerate(pdf.pages,1):
   page_text=page.extract_text() or ''
   if not re.search(r'Table [23]\. (?:Multi-Service Brevity Codes|Standard Tactical Chat)',page_text):continue
   for table in page.extract_tables():
    for row in table:
     if len(row)<2:continue
     name=(row[0] or '').strip();definition=' '.join(cell or '' for cell in row[1:]).strip()
     if not name and pending and definition:
      pending['definition']+=' '+definition;continue
     if not name or not definition or name.lower() in ['term','brevity code','brevity codes','code']:continue
     # The alphabetic glossary uses uppercase terms; tables outside it are not entries.
     core=re.sub(r'\[[^\]]*\]','',name).strip(' *')
     if not core or core.upper()!=core or not re.search('[A-Z]',core) or len(name)>140:continue
     url='https://www.alssa.mil/Portals/9/Documents/mttps/brevity_2025.pdf#page='+str(page_number)
     pending=dict(id=key('alssa',url+'|'+name),term=re.sub(r'\s+',' ',name).strip(),source='alssa',url=url,definition=re.sub(r'\s+',' ',definition))
     entries.append(pending)
  print('ALSSA extracted',sum(e['source']=='alssa' for e in entries),flush=True)
ids=[e['id'] for e in entries]
if len(set(ids))!=len(ids):
 unique={}
 for entry in entries:
  if entry['id'] not in unique:unique[entry['id']]=entry;continue
  previous=unique[entry['id']]
  if entry['definition'] not in previous['definition']:previous['definition']+=' / '+entry['definition']
 print('Merged repeated source rows',len(entries)-len(unique),flush=True)
 entries=list(unique.values())
(cache/'raw-terms.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding='utf8')
print('Total',len(entries),flush=True)
