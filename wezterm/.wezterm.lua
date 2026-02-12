local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- CONFIGURATION

config.color_scheme = 'Ayu Dark (Gogh)'
config.font_size = 14

config.window_decorations = 'RESIZE'

config.hide_tab_bar_if_only_one_tab = true

-- CUSTOM TAB Color
--
-- This function returns the suggested title for a tab.
-- It prefers the title that was set via `tab:set_title()`
-- or `wezterm cli set-tab-title`, but falls back to the
-- title of the active pane in that tab.
function tab_title(tab_info)
  local title = tab_info.tab_title
  -- if the tab title is explicitly set, take that
  if title and #title > 0 then
    return title
  end
  -- Otherwise, use the title from the active pane
  -- in that tab
  return tab_info.active_pane.title
end

wezterm.on(
  'format-tab-title',
  function(tab, tabs, panes, config, hover, max_width)
    local title = tab_title(tab)
    if tab.is_active then
      return {
        { Background = { Color = '0d1016ff' } },
        { Text = ' ' .. title .. ' ' },
      }
    end
    return title
  end
)

--- END of CUSTOM TAB Color

-- Key bindings
config.keys = {
  {
    key = 'd',
    mods = 'CMD',
    action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' },
  },
  {
    key = 'd',
    mods = 'CMD|SHIFT',
    action = wezterm.action.SplitVertical { domain = 'CurrentPaneDomain' },
  },
  {
    key = 'w',
    mods = 'CMD',
    action = wezterm.action.CloseCurrentPane { confirm = false },
  },
}

-- END OF CONFIGURATION
return config
