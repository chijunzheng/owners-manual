/**
 * One-off manifest author: fetches every corpus source once, applies the
 * documented normalization, and prints a manifest JSON with the recorded
 * checksums. NOT part of the product or CI — it is the human/AFK tool used to
 * (re)record the manifest when sources are added or a new consolidation lands.
 * Run from the package directory:
 *
 *   ./node_modules/.bin/tsx scripts/generate-manifest.ts > ../../corpus/manifest.json
 *
 * The committed manifest is the source of truth thereafter; `corpus:fetch`
 * verifies against it and never regenerates it.
 */

import { checksum } from '../src/hash.ts'
import { curlByteSource } from '../src/curl.ts'
import type { ManifestSource, NormalizationPolicy } from '../src/manifest/schema.ts'

interface SourceSpec {
  id: string
  title: string
  url: string
  file: string
  consolidationDate: string
  licence: { holder: string; note: string }
  normalization: NormalizationPolicy
}

const KP = "King's Printer for Ontario"
const KP_NOTE =
  'Statute/regulation text © King’s Printer for Ontario. Reproduced for personal, ' +
  'non-commercial research use under the Copyright & Disclaimer terms at ontario.ca/page/copyright-information. ' +
  'Not redistributed: corpus/raw/ is gitignored; this manifest reproduces it.'
const TO_NOTE =
  'Landlord and Tenant Board interpretation guideline © Tribunals Ontario. Reproduced for ' +
  'personal, non-commercial research use. Not redistributed: corpus/raw/ is gitignored.'

const LTB = 'https://tribunalsontario.ca/documents/ltb/Interpretation%20Guidelines'

const SPECS: readonly SourceSpec[] = [
  {
    id: 'rta-2006',
    title: 'Residential Tenancies Act, 2006, S.O. 2006, c. 17',
    url: 'https://www.ontario.ca/laws/statute/06r17',
    file: 'tenancy/rta-2006.html',
    consolidationDate: '2025-11-27',
    licence: { holder: KP, note: KP_NOTE },
    normalization: 'strip-waf',
  },
  {
    id: 'reg-516-06',
    title: 'O. Reg. 516/06: General (under the Residential Tenancies Act, 2006)',
    url: 'https://www.ontario.ca/laws/regulation/060516',
    file: 'tenancy/reg-516-06.html',
    consolidationDate: '2020-11-30',
    licence: { holder: KP, note: KP_NOTE },
    normalization: 'strip-waf',
  },
  {
    id: 'rent-increase-guideline',
    title: 'Rent increase guideline (ontario.ca currency micro-source)',
    url: 'https://www.ontario.ca/page/rent-increase-guideline',
    file: 'tenancy/rent-increase-guideline.html',
    consolidationDate: '2025-06-01',
    licence: {
      holder: 'Government of Ontario',
      note:
        'Rent-increase guideline page © Government of Ontario. Currency micro-source: the page states ' +
        'the guideline for the current year and changes annually — re-record on each new guideline. ' +
        'Reproduced for personal research use; corpus/raw/ is gitignored.',
    },
    normalization: 'strip-waf',
  },
  {
    id: 'condo-act-1998',
    title: 'Condominium Act, 1998, S.O. 1998, c. 19',
    url: 'https://www.ontario.ca/laws/statute/98c19',
    file: 'governing/condo-act-1998.html',
    consolidationDate: '2025-12-31',
    licence: { holder: KP, note: KP_NOTE },
    normalization: 'strip-waf',
  },
  {
    id: 'reg-48-01',
    title: 'O. Reg. 48/01: General (under the Condominium Act, 1998)',
    url: 'https://www.ontario.ca/laws/regulation/010048',
    file: 'governing/reg-48-01.html',
    consolidationDate: '2023-10-01',
    licence: { holder: KP, note: KP_NOTE },
    normalization: 'strip-waf',
  },
  // LTB interpretation guidelines — the substantive standalone documents (not
  // the WordPress index page, which carries unstable per-request cache-busters).
  // A focused, extensible v1 tenancy core: eviction, maintenance, rights,
  // arrears, above-guideline increases. The consolidation date is the LTB's
  // stated issue/revision date where shown, else the page's effective date.
  guideline('01', '01 - Adjourning and Rescheduling Hearings_dec2020.html', 'Interpretation Guideline 1: Adjourning and Rescheduling Hearings', '2020-12-15'),
  guideline('05', '05 - Breach of Maintenance Obligations.html', 'Interpretation Guideline 5: Breach of Maintenance Obligations', '2018-09-01'),
  guideline('06', '06 - Tenants Rights.html', "Interpretation Guideline 6: Tenants' Rights", '2018-09-01'),
  guideline('07', '07 - Relief from Eviction - Refusing or Delaying an Eviction_dec2020.html', 'Interpretation Guideline 7: Relief from Eviction', '2020-12-15'),
  guideline('11', '11 - Rent Arrears.html', 'Interpretation Guideline 11: Rent Arrears', '2018-09-01'),
  guideline('12', '12 - Eviction for Personal Use.html', 'Interpretation Guideline 12: Eviction for Personal Use', '2018-09-01'),
  guideline('14', '14 - Applications for Rent Increases above the Guideline.html', 'Interpretation Guideline 14: Applications for Rent Increases Above the Guideline', '2018-09-01'),
]

function guideline(num: string, fileName: string, title: string, date: string): SourceSpec {
  return {
    id: `ltb-guideline-${num}`,
    title,
    url: `${LTB}/${encodeURIComponent(fileName)}`,
    file: `tenancy/ltb-guidelines/${num}.html`,
    consolidationDate: date,
    licence: { holder: 'Tribunals Ontario', note: TO_NOTE },
    normalization: 'strip-waf',
  }
}

async function main(): Promise<void> {
  const source = curlByteSource()
  const sources: ManifestSource[] = []

  for (const spec of SPECS) {
    const raw = await source.read({ ...spec } as ManifestSource)
    const { sha256, bytes } = checksum(raw, spec.normalization)
    sources.push({
      id: spec.id,
      title: spec.title,
      url: spec.url,
      file: spec.file,
      sha256,
      bytes,
      consolidationDate: spec.consolidationDate,
      licence: spec.licence,
      normalization: spec.normalization,
    })
    process.stderr.write(`fetched ${spec.id}: ${bytes} bytes, ${sha256}\n`)
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources,
  }
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
