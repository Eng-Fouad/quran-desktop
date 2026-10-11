/** The Arabic dictionary (§11.1; WP0C, frozen). `satisfies Dict` makes a missing or extra key a compile error. */
import type { Dict } from '$lib/contracts/i18n'
import { common } from './common'
import { shortcuts } from './shortcuts'
import { errors } from './errors'
import { shell } from './shell'
import { mushaf } from './mushaf'
import { fonts } from './fonts'
import { furniture } from './furniture'
import { interactions } from './interactions'
import { reader } from './reader'
import { pagenav } from './pagenav'
import { player } from './player'
import { memo } from './memo'
import { navigation } from './navigation'
import { search } from './search'
import { palette } from './palette'
import { content } from './content'
import { sidepane } from './sidepane'
import { library } from './library'
import { notes } from './notes'
import { downloads } from './downloads'
import { settings } from './settings'
import { onboarding } from './onboarding'
import { about } from './about'

export const ar = {
  common,
  shortcuts,
  errors,
  shell,
  mushaf,
  fonts,
  furniture,
  interactions,
  reader,
  pagenav,
  player,
  memo,
  navigation,
  search,
  palette,
  content,
  sidepane,
  library,
  notes,
  downloads,
  settings,
  onboarding,
  about,
} satisfies Dict
