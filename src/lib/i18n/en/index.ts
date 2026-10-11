/**
 * The English dictionary: the source of truth for every message key (§11.1; WP0C, frozen). `common`, `shortcuts` and
 * `errors` are complete frozen contracts; every other domain file belongs to the package named in it.
 */
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

export const en = {
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
} as const
