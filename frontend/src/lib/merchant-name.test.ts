import { describe, expect, it } from 'vitest'
import { merchantName } from './merchant-name'

describe('merchantName', () => {
  it('drops processor prefixes and title-cases shouting text', () => {
    expect(merchantName('MP*MERCADOLIVRE')).toBe('Mercadolivre')
    expect(merchantName('PG *ESTRATEGIACON')).toBe('Estrategiacon')
    expect(merchantName('AMAZON BRSAO PAULO')).toBe('Amazon Brsao Paulo')
    expect(merchantName('VINDI*Shop2getherS')).toBe('Shop2getherS')
  })

  it('keeps mixed-case names and small words', () => {
    expect(merchantName('Vivara lojavivarSA')).toBe('Vivara lojavivarSA')
    expect(merchantName('CASA DO PAO DE QUEIJO')).toBe('Casa do Pao de Queijo')
  })
})
