# strudelPWA.nvim

## Installation

```lua
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(ev)
    local name, kind = ev.data.spec.name, ev.data.kind
    vim.print("PackChanged event triggered for plugin: " .. name .. " with kind: " .. kind)
    if name == "strudelPWA.nvim" and (kind == "install" or kind == "update") then
      vim.print("Building strudel.nvim... triggered by PackChanged event")
      vim.system({ "npm", "ci" } , { cwd = ev.data.path })
    end
  end,
})

vim.pack.add({
  src = "https://github.com/odezzshuuk/strudelPWA.nvim" 
})
```

## Notes

After `:StrudelStart`, the plugin persists the browser debugging port under `vim.fn.stdpath("state") .. "/strudelPWA/debugging_port"`.
That lets a fresh Neovim session run `:StrudelAttach` against the existing Strudel browser session without re-entering the port manually.

