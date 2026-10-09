import type { Icon } from '@phosphor-icons/react'
import {
  Airplane, ArrowsLeftRight, Baby, Bank, Barbell, Barcode, Basket, BeerStein, Bed,
  Bicycle, BookOpen, Brain, Briefcase, Broom, Buildings, Bus, CalendarCheck, Camera, Car,
  CarProfile, Cat, ChalkboardTeacher, ChartLineUp, Church, Cloud, Code, Coffee, Coins,
  Confetti, CookingPot, Couch, CreditCard, CurrencyBtc, Desktop, DeviceMobile, DiceFive,
  Dog, Dress, Drop, Eyeglasses, FileText, FilmSlate, FirstAidKit, Flame, Flower,
  ForkKnife, GameController, Garage, GasPump, Gift, Globe, GraduationCap, Hamburger,
  Hammer, HandCoins, HandHeart, Handshake, Headphones, Heart, Heartbeat, House, Invoice,
  Key, Laptop, Lightbulb, Lightning, MapPin, Money, Motorcycle, Mountains, MusicNotes,
  Package, PaintBrush, PawPrint, Percent, PiggyBank, Pill, Pizza, Plant, Popcorn,
  Question, Receipt, Repeat, Scales, Scissors, ShieldCheck, ShoppingBag, ShoppingCart,
  Sneaker, SoccerBall, Sparkle, Stethoscope, Storefront, Student, Suitcase, SwimmingPool,
  Syringe, Taxi, Television, Ticket, Tooth, Train, Tree, TrendDown, TrendUp, Truck, TShirt,
  Umbrella, Users, Wallet, WashingMachine, Watch, WifiHigh, Wine, Wrench,
} from '@phosphor-icons/react'

export interface CategoryIconEntry {
  /** Stored in the DB. Lucide-style kebab names are kept for the original
   *  set so categories saved before the switch to Phosphor still resolve. */
  name: string
  /** Portuguese label, also used for search in the picker. */
  label: string
  icon: Icon
}

export const CATEGORY_ICONS: CategoryIconEntry[] = [
  // Moradia & Casa
  { name: 'house', label: 'Casa / Moradia', icon: House },
  { name: 'key', label: 'Aluguel / Chave', icon: Key },
  { name: 'buildings', label: 'Condomínio / Prédio', icon: Buildings },
  { name: 'lightbulb', label: 'Luz / Energia', icon: Lightbulb },
  { name: 'droplets', label: 'Água', icon: Drop },
  { name: 'flame', label: 'Gás', icon: Flame },
  { name: 'wifi', label: 'Internet / Wi-Fi', icon: WifiHigh },
  { name: 'tv', label: 'TV / Streaming', icon: Television },
  { name: 'couch', label: 'Móveis / Decoração', icon: Couch },
  { name: 'washing-machine', label: 'Eletrodomésticos / Lavanderia', icon: WashingMachine },
  { name: 'broom', label: 'Limpeza / Diarista', icon: Broom },
  { name: 'plant', label: 'Plantas / Jardim', icon: Plant },
  // Alimentação
  { name: 'utensils-crossed', label: 'Alimentação / Restaurante', icon: ForkKnife },
  { name: 'hamburger', label: 'Lanche / Fast food', icon: Hamburger },
  { name: 'pizza', label: 'Pizza / Delivery', icon: Pizza },
  { name: 'coffee', label: 'Café / Padaria', icon: Coffee },
  { name: 'beer', label: 'Bebidas / Bar', icon: BeerStein },
  { name: 'wine', label: 'Vinho / Adega', icon: Wine },
  { name: 'cooking-pot', label: 'Cozinha / Feira', icon: CookingPot },
  { name: 'basket', label: 'Hortifruti / Cesta', icon: Basket },
  { name: 'salad', label: 'Saudável', icon: Plant },
  // Transporte
  { name: 'car', label: 'Carro / Transporte', icon: Car },
  { name: 'car-profile', label: 'Financiamento / Veículo', icon: CarProfile },
  { name: 'fuel', label: 'Combustível', icon: GasPump },
  { name: 'taxi', label: 'Táxi / App de corrida', icon: Taxi },
  { name: 'garage', label: 'Estacionamento / Garagem', icon: Garage },
  { name: 'wrench', label: 'Manutenção / Oficina', icon: Wrench },
  { name: 'motorcycle', label: 'Moto', icon: Motorcycle },
  { name: 'bus', label: 'Ônibus', icon: Bus },
  { name: 'train', label: 'Trem / Metrô', icon: Train },
  { name: 'bike', label: 'Bicicleta', icon: Bicycle },
  // Viagem
  { name: 'plane', label: 'Avião / Viagem', icon: Airplane },
  { name: 'bed', label: 'Hotel / Hospedagem', icon: Bed },
  { name: 'suitcase', label: 'Bagagem / Turismo', icon: Suitcase },
  { name: 'map-pin', label: 'Passeio / Lugar', icon: MapPin },
  // Compras
  { name: 'shopping-cart', label: 'Mercado / Supermercado', icon: ShoppingCart },
  { name: 'shopping-bag', label: 'Compras / Loja', icon: ShoppingBag },
  { name: 'package', label: 'Compras online / Encomenda', icon: Package },
  { name: 'storefront', label: 'Loja / Comércio', icon: Storefront },
  { name: 'gift', label: 'Presente', icon: Gift },
  { name: 'shirt', label: 'Roupa / Vestuário', icon: TShirt },
  { name: 'dress', label: 'Moda', icon: Dress },
  { name: 'sneaker', label: 'Calçados', icon: Sneaker },
  { name: 'watch', label: 'Acessórios / Relógio', icon: Watch },
  { name: 'laptop', label: 'Eletrônicos / Notebook', icon: Laptop },
  { name: 'desktop', label: 'Computador', icon: Desktop },
  { name: 'camera', label: 'Foto / Câmera', icon: Camera },
  // Saúde & Cuidados
  { name: 'pill', label: 'Remédio / Farmácia', icon: Pill },
  { name: 'stethoscope', label: 'Médico / Consulta', icon: Stethoscope },
  { name: 'tooth', label: 'Dentista', icon: Tooth },
  { name: 'eyeglasses', label: 'Ótica', icon: Eyeglasses },
  { name: 'brain', label: 'Terapia / Psicólogo', icon: Brain },
  { name: 'syringe', label: 'Vacina / Exame', icon: Syringe },
  { name: 'cross', label: 'Hospital / Emergência', icon: FirstAidKit },
  { name: 'heartbeat', label: 'Plano de saúde', icon: Heartbeat },
  { name: 'heart', label: 'Saúde / Bem-estar', icon: Heart },
  { name: 'dumbbell', label: 'Academia / Exercício', icon: Barbell },
  { name: 'scissors', label: 'Cabelo / Beleza', icon: Scissors },
  { name: 'flower', label: 'Estética / Cuidados', icon: Flower },
  // Lazer
  { name: 'gamepad-2', label: 'Jogos / Games', icon: GameController },
  { name: 'music', label: 'Música', icon: MusicNotes },
  { name: 'headphones', label: 'Áudio / Podcast', icon: Headphones },
  { name: 'film', label: 'Cinema / Filme', icon: FilmSlate },
  { name: 'popcorn', label: 'Entretenimento', icon: Popcorn },
  { name: 'ticket', label: 'Ingressos / Shows', icon: Ticket },
  { name: 'party-popper', label: 'Festa / Evento', icon: Confetti },
  { name: 'soccer-ball', label: 'Esporte', icon: SoccerBall },
  { name: 'swimming-pool', label: 'Clube / Piscina', icon: SwimmingPool },
  { name: 'mountains', label: 'Natureza / Trilha', icon: Mountains },
  { name: 'dice', label: 'Apostas / Loteria', icon: DiceFive },
  // Tecnologia & Assinaturas
  { name: 'smartphone', label: 'Celular / Telefone', icon: DeviceMobile },
  { name: 'cloud', label: 'Nuvem / Software', icon: Cloud },
  { name: 'code', label: 'Ferramentas dev', icon: Code },
  { name: 'calendar-check', label: 'Assinaturas', icon: CalendarCheck },
  { name: 'repeat', label: 'Recorrente', icon: Repeat },
  { name: 'credit-card', label: 'Cartão de crédito', icon: CreditCard },
  // Educação
  { name: 'book-open', label: 'Livro / Leitura', icon: BookOpen },
  { name: 'graduation-cap', label: 'Faculdade / Curso', icon: GraduationCap },
  { name: 'student', label: 'Escola', icon: Student },
  { name: 'chalkboard', label: 'Aulas / Idiomas', icon: ChalkboardTeacher },
  // Trabalho & Negócios
  { name: 'briefcase', label: 'Trabalho / Negócios', icon: Briefcase },
  { name: 'building-2', label: 'Empresa / Escritório', icon: Buildings },
  { name: 'handshake', label: 'Clientes / Serviços', icon: Handshake },
  { name: 'truck', label: 'Frete / Logística', icon: Truck },
  { name: 'paint-brush', label: 'Design / Criativo', icon: PaintBrush },
  // Finanças
  { name: 'landmark', label: 'Banco / Governo', icon: Bank },
  { name: 'wallet', label: 'Carteira', icon: Wallet },
  { name: 'banknote', label: 'Dinheiro / Salário', icon: Money },
  { name: 'coins', label: 'Rendimentos / Juros', icon: Coins },
  { name: 'hand-coins', label: 'Empréstimo / Pagamento', icon: HandCoins },
  { name: 'piggy-bank', label: 'Poupança / Reserva', icon: PiggyBank },
  { name: 'trending-up', label: 'Investimentos', icon: TrendUp },
  { name: 'chart-line-up', label: 'Bolsa / Ações', icon: ChartLineUp },
  { name: 'bitcoin', label: 'Cripto', icon: CurrencyBtc },
  { name: 'trending-down', label: 'Prejuízo / Perda', icon: TrendDown },
  { name: 'receipt', label: 'Recibo / Nota fiscal', icon: Receipt },
  { name: 'invoice', label: 'Fatura / Cobrança', icon: Invoice },
  { name: 'barcode', label: 'Boleto', icon: Barcode },
  { name: 'lightning', label: 'Pix', icon: Lightning },
  { name: 'percent', label: 'Taxas / Tarifas', icon: Percent },
  { name: 'file-text', label: 'Impostos / Documentos', icon: FileText },
  { name: 'scales', label: 'Jurídico / Cartório', icon: Scales },
  { name: 'shield-check', label: 'Seguro', icon: ShieldCheck },
  { name: 'arrow-left-right', label: 'Transferência', icon: ArrowsLeftRight },
  // Família, Pets & Doações
  { name: 'baby', label: 'Bebê / Filhos', icon: Baby },
  { name: 'users', label: 'Família', icon: Users },
  { name: 'dog', label: 'Pet / Cachorro', icon: Dog },
  { name: 'cat', label: 'Pet / Gato', icon: Cat },
  { name: 'paw-print', label: 'Pet shop / Veterinário', icon: PawPrint },
  { name: 'hand-heart', label: 'Doações', icon: HandHeart },
  // Seeded by the backend for the default "Donations" category.
  { name: 'heart-handshake', label: 'Caridade / Doação', icon: Handshake },
  { name: 'church', label: 'Igreja / Dízimo', icon: Church },
  // Serviços & Outros
  { name: 'hammer', label: 'Construção / Reforma', icon: Hammer },
  { name: 'tree-pine', label: 'Natureza / Jardim', icon: Tree },
  { name: 'umbrella', label: 'Proteção', icon: Umbrella },
  { name: 'globe', label: 'Internacional', icon: Globe },
  { name: 'sparkles', label: 'Especial', icon: Sparkle },
  { name: 'circle-help', label: 'Outros / Indefinido', icon: Question },
]

// O(1) lookup map: icon-name → Phosphor icon component
export const ICON_MAP: Record<string, Icon> = Object.fromEntries(
  CATEGORY_ICONS.map((entry) => [entry.name, entry.icon])
)

// Check if a string is an emoji (for backward compatibility with old data)
export function isEmoji(str: string): boolean {
  // Emoji strings are typically 1-2 characters with high code points
  return str.length <= 2 && /\p{Emoji}/u.test(str)
}
