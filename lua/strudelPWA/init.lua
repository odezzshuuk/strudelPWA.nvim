local base64 = require("strudelPWA.base64")
local uv = vim.loop

local M = {}

local MESSAGES = {
  CONTENT = "STRUDEL_CONTENT:",
  QUIT = "STRUDEL_QUIT",
  TOGGLE = "STRUDEL_TOGGLE",
  UPDATE = "STRUDEL_UPDATE",
  STOP = "STRUDEL_STOP",
  REFRESH = "STRUDEL_REFRESH",
  READY = "STRUDEL_READY",
  CURSOR = "STRUDEL_CURSOR:",
  EVAL_ERROR = "STRUDEL_EVAL_ERROR:",
}

local STRUDEL_SYNC_AUTOCOMMAND = "StrudelPWASync"
local SUCCESSIVE_CMD_DELAY = 50
local PORT_STATE_DIR = vim.fn.stdpath("state") .. "/strudelPWA"
local PORT_STATE_FILE = PORT_STATE_DIR .. "/debugging_port"

-- State
local attach_job_id = nil
local last_content = nil
local strudel_synced_bufnr = nil
local editor_attached = false
local custom_css_b64 = nil
local last_received_cursor = nil -- {row, col}

-- Event queue for sequential message processing
local event_queue = {}
local is_processing_event = false

-- Config with default options
local config = {

  ui = {
    maximise_menu_panel = true,
    hide_menu_panel = false,
    hide_top_bar = false,
    hide_code_editor = false,
    hide_error_display = false,
    custom_css_file = nil,
  },
  browser = {
    headless = false,
    user_data_dir = vim.fn.expand("~/.cache/strudelPWA-nvim"),
    browser_exec_path = "chrome",
    proxy = nil,
  },

  editor = {
    update_on_save = false,
    sync_cursor = true,
    update_on_attach = true,
  },

  report_eval_errors = true,
  strudel_url = "https://cold.strudel.cc",
  log_level = "INFO",
}

---@type number | nil
local debugging_port

local function persist_debugging_port(port)
  vim.fn.mkdir(PORT_STATE_DIR, "p")
  local ok, err = pcall(vim.fn.writefile, { tostring(port) }, PORT_STATE_FILE)
  if not ok then
    vim.notify("Failed to persist Strudel debugging port: " .. tostring(err), vim.log.levels.WARN)
  end
end

local function read_persisted_debugging_port()
  local stat = uv.fs_stat(PORT_STATE_FILE)
  if not stat then
    return nil
  end

  local lines = vim.fn.readfile(PORT_STATE_FILE)
  local persisted_port = tonumber(lines[1])
  if not persisted_port then
    vim.notify("Invalid persisted Strudel debugging port in " .. PORT_STATE_FILE, vim.log.levels.WARN)
    return nil
  end

  return persisted_port
end

local function clear_persisted_debugging_port()
  if uv.fs_stat(PORT_STATE_FILE) then
    vim.fn.delete(PORT_STATE_FILE)
  end
end

local function send_message(message)
  if attach_job_id then
    vim.fn.chansend(attach_job_id, message .. "\n")
  else
    vim.notify("No active Strudel session", vim.log.levels.WARN)
  end
end

local function send_cursor_position()
  if
      not attach_job_id
      or not strudel_synced_bufnr
      or not editor_attached
      or not config.editor.sync_cursor
  then
    return
  end
  if not vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
    return
  end

  local pos = vim.api.nvim_win_get_cursor(0)
  local row, col = pos[1], pos[2]
  if last_received_cursor and last_received_cursor[1] == row and last_received_cursor[2] == col then
    return
  end
  send_message(MESSAGES.CURSOR .. row .. ":" .. col)
end

local function send_buffer_content()
  if not attach_job_id or not strudel_synced_bufnr or not editor_attached then
    return
  end
  if not vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(strudel_synced_bufnr, 0, -1, false)
  local content = table.concat(lines, "\n")
  local base64_content = base64.encode(content)

  if base64_content ~= last_content then
    last_content = base64_content
    send_message(MESSAGES.CONTENT .. base64_content)
    vim.defer_fn(function()
      send_cursor_position()
    end, SUCCESSIVE_CMD_DELAY)
  end
end

local function set_buffer_content(bufnr, content)
  local lines = {}
  if content ~= "" then
    lines = vim.split(content, "\n")
  end

  vim.schedule(function()
    if not vim.api.nvim_buf_is_valid(bufnr) then
      return
    end

    -- Save current window view (persist cursor location across content update)
    local view = vim.fn.winsaveview()
    -- Update buffer content
    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
    -- Restore window view
    vim.fn.winrestview(view)
  end)
end

local function set_buffer(opts)
  vim.api.nvim_clear_autocmds({ group = STRUDEL_SYNC_AUTOCOMMAND })

  if not attach_job_id then
    vim.notify("No active Strudel session", vim.log.levels.WARN)
    return false
  end

  local bufnr = opts and opts.args and opts.args ~= "" and tonumber(opts.args)
      or vim.api.nvim_get_current_buf()
  if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then
    vim.notify("Invalid buffer number for :StrudelSetBuffer", vim.log.levels.ERROR)
    return false
  end

  strudel_synced_bufnr = bufnr
  send_buffer_content()

  -- Set up autocommand to sync buffer changes
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = STRUDEL_SYNC_AUTOCOMMAND,
    buffer = bufnr,
    callback = function()
      if not is_processing_event and strudel_synced_bufnr then
        send_buffer_content()
      end
    end,
  })

  -- Set up autocommand to sync cursor position if enabled
  if config.editor.sync_cursor then
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
      group = STRUDEL_SYNC_AUTOCOMMAND,
      buffer = bufnr,
      callback = function()
        if not is_processing_event then
          send_cursor_position()
        end
      end,
    })
  end

  -- Set up autocommand to update on save
  if config.editor.update_on_save then
    vim.api.nvim_create_autocmd("BufWritePost", {
      group = STRUDEL_SYNC_AUTOCOMMAND,
      buffer = bufnr,
      callback = function()
        if attach_job_id then
          -- Use the REFRESH message to update only when already playing
          send_message(MESSAGES.REFRESH)
        end
      end,
    })
  end

  local buffer_name = vim.fn.bufname(bufnr)
  if buffer_name == "" then
    buffer_name = "#" .. bufnr
  end
  vim.notify("Strudel is now syncing buffer " .. buffer_name, vim.log.levels.INFO)

  return true
end

local function handle_event(full_data)
  if full_data:match("^" .. MESSAGES.READY) then
    editor_attached = true
    if strudel_synced_bufnr then
      send_buffer_content()
      if config.editor.update_on_attach then
        vim.defer_fn(function()
          M.update()
        end, SUCCESSIVE_CMD_DELAY * 2)
      end
    end
  elseif full_data:match("^" .. MESSAGES.CONTENT) then
    local content_b64 = full_data:sub(#MESSAGES.CONTENT + 1)
    if content_b64 == last_content then
      return
    end
    last_content = content_b64
    if strudel_synced_bufnr and vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
      local content = base64.decode(content_b64)
      set_buffer_content(strudel_synced_bufnr, content)
    end
  elseif full_data:match("^" .. MESSAGES.CURSOR) and config.editor.sync_cursor then
    local cursor_str = full_data:sub(#MESSAGES.CURSOR + 1)
    local row, col = cursor_str:match("^(%d+):(%d+)$")
    row, col = tonumber(row), tonumber(col)
    if row and col and strudel_synced_bufnr and vim.api.nvim_buf_is_valid(strudel_synced_bufnr) then
      vim.schedule(function()
        local line_count = vim.api.nvim_buf_line_count(strudel_synced_bufnr)
        local clamped_row = math.max(1, math.min(row, line_count))
        local line = vim.api.nvim_buf_get_lines(
          strudel_synced_bufnr,
          clamped_row - 1,
          clamped_row,
          false
        )[1] or ""
        local clamped_col = math.max(0, math.min(col, #line))
        last_received_cursor = { clamped_row, clamped_col }
        vim.api.nvim_win_set_cursor(0, { clamped_row, clamped_col })
      end)
    end
  elseif full_data:match("^" .. MESSAGES.EVAL_ERROR) then
    local error_b64 = full_data:sub(#MESSAGES.EVAL_ERROR + 1)
    local error = base64.decode(error_b64)
    if config.report_eval_errors then
      vim.schedule(function()
        vim.notify("Strudel Error: " .. error, vim.log.levels.ERROR)
      end)
    end
  else
    vim.schedule(function()
      vim.notify(full_data, vim.log.levels.WARN)
    end)
  end
end

local function attach_process_event_queue()
  if is_processing_event then
    return
  end

  is_processing_event = true

  vim.schedule(function()
    while #event_queue > 0 do
      local message = table.remove(event_queue, 1)
      handle_event(message)
    end

    is_processing_event = false
  end)
end

---Finds an available TCP port on the local machine.
---@return number: An available port number.
local function get_free_port()
  local server = uv.new_tcp()
  local port = 0
  local ok, err = server:bind("127.0.0.1", 0)
  if ok then
    local sock_name = server:getsockname()
    if sock_name then
      port = sock_name.port
    end
  else
    -- Fallback, should be rare
    port = math.random(49152, 65535) end server:close()
  return port
end

---Splits a command-line string into tokens, handling quotes and escapes.
---@param command string The command line string.
---@return string[]
local function split_command_line(command)
  local tokens = {}
  local current = ""
  local quote = nil
  local escaping = false

  for i = 1, #command do
    local char = command:sub(i, i)
    if escaping then
      current = current .. char
      escaping = false
    elseif char == "\\" then
      escaping = true
    elseif quote then
      if char == quote then
        quote = nil
      else
        current = current .. char
      end
    elseif char == '"' or char == "'" then
      quote = char
    elseif char:match("%s") then
      if #current > 0 then
        table.insert(tokens, current)
        current = ""
      end
    else
      current = current .. char
    end
  end

  if #current > 0 then
    table.insert(tokens, current)
  end

  return tokens
end

---@param args string[]
---@return string[]
local function strip_desktop_field_codes(args)
  local result = {}

  for _, arg in ipairs(args) do
    local stripped_arg = arg:gsub("%%[fFuUdDnNickvm]", "")
    if #stripped_arg > 0 then
      table.insert(result, stripped_arg)
    end
  end

  return result
end

local function get_local_pwa_command()
  local home = os.getenv("HOME")
  if not home then
    return nil
  end
  local applications_dir = home .. "/.local/share/applications"

  local handle = uv.fs_scandir(applications_dir)
  if not handle then
    return nil
  end

  while true do
    local name, _ = uv.fs_scandir_next(handle)
    if not name then
      break
    end

    if name:match("%.desktop$") then
      local file_path = applications_dir .. "/" .. name
      local file = io.open(file_path, "r")
      if file then
        ---@type string
        local content = file:read("*a")
        file:close()

        local in_desktop_entry = false
        local app_name = nil
        local exec_cmd = nil

        local normalized_content = content:gsub("\r\n", "\n"):gsub("\r", "\n")

        for line in (normalized_content .. "\n"):gmatch("([^\n]*)\n") do
          local trimmed_line = line:match("^%s*(.-)%s*$") -- trim
          if #trimmed_line > 0 and not trimmed_line:match("^#") then
            if trimmed_line:match("^%[") and trimmed_line:match("%]$") then
              in_desktop_entry = (trimmed_line == "[Desktop Entry]")
            elseif in_desktop_entry then
              local eq = trimmed_line:find("=")
              if eq then
                local key = trimmed_line:sub(1, eq - 1)
                local value = trimmed_line:sub(eq + 1)
                if key == "Name" then
                  app_name = value
                elseif key == "Exec" then
                  exec_cmd = value
                end
              end
            end
          end
        end

        if app_name == "Strudel REPL" and exec_cmd then
          local tokens = strip_desktop_field_codes(split_command_line(exec_cmd))
          local cmd = table.remove(tokens, 1)
          if cmd then
            local args = {}
            for _, arg in ipairs(tokens) do
              if arg:match("^--") then
                local key, value = arg:match("^(%-%-[^=]+)=(.*)$")
                if not key then
                  key = arg
                  value = true
                end
                args[key] = value
              end
            end
            return { cmd = cmd, args = args }
          end
        end
      end
    end
  end
  return nil
end

-- Public API
function M.setup(opts)
  opts = opts or {}
  config = vim.tbl_deep_extend("force", config, opts)

  -- Load custom CSS content and base64 encode it
  local css_path = config.custom_css_file
  if css_path then
    local f = io.open(css_path, "rb")
    if f then
      local css = f:read("*a")
      f:close()
      custom_css_b64 = base64.encode(css)
    else
      vim.notify("Could not read custom CSS file: " .. css_path, vim.log.levels.ERROR)
    end
  end

  -- Create autocmd group
  vim.api.nvim_create_augroup(STRUDEL_SYNC_AUTOCOMMAND, { clear = true })

  -- Set file type for .str, .std files to JavaScript
  vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
    pattern = { "*.str", "*.std" },
    callback = function()
      vim.bo.filetype = "javascript"
    end,
  })

  -- Commands
  vim.api.nvim_create_user_command("StrudelStart", M.start_strudel, {
    nargs = "*",
    complete = function(arg_lead)
      local commands = { "proxy" }
      return vim.tbl_filter(function(cmd)
        return cmd:lower():find(arg_lead:lower(), 1, true)
      end, commands)
    end,
  })
  vim.api.nvim_create_user_command("StrudelAttach", M.attach_editor, {})
  vim.api.nvim_create_user_command("StrudelQuit", M.quit, {})
  vim.api.nvim_create_user_command("StrudelToggle", M.toggle, {})
  vim.api.nvim_create_user_command("StrudelUpdate", M.update, {})
  vim.api.nvim_create_user_command("StrudelStop", M.stop, {})
  vim.api.nvim_create_user_command("StrudelSetBuffer", set_buffer, { nargs = "?" })
  vim.api.nvim_create_user_command("StrudelExecute", M.execute, {})
end


function M.start_strudel(opts)
  if opts.fargs[1] then
    ---@type string, string
    local key, value = opts.fargs[1]:match("^([%w_%-]+)=(.+)")
    if key == "proxy" and value ~= "" then
      if value:match("^https?://") then
        config.browser.proxy = value
      elseif value:match("^%d+$") then
        config.browser.proxy = "http://localhost:" .. value
      else
        vim.notify("Invalid proxy format. Use proxy=http://example:8080 or proxy=8080", vim.log.levels.ERROR)
        return
      end
    else
      vim.notify("Invalid argument for :StrudelStart. Usage: :StrudelStart proxy=http://my-proxy:8080", vim.log.levels.ERROR)
      return
    end
  end

  local pwa_command = get_local_pwa_command()
  debugging_port = get_free_port()
  persist_debugging_port(debugging_port)

  ---@type string[]
  local args
  ---@type string
  local executable

--  local user_data_dir_arg = "--user-data-dir=" .. user_data_dir

  if pwa_command and pwa_command.args["--user-data-dir"] then
    executable = pwa_command.cmd
    args = {
      "--user-data-dir=" .. config.browser.user_data_dir,
      "--profile-directory=Default",
      "--app-id=" .. pwa_command.args["--app-id"],
      "--remote-debugging-port=" .. debugging_port,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
    }
  else
    executable = config.browser.browser_exec_path
    args = {
      "--profile-directory=Default",
      "--user-data-dir=" .. config.browser.user_data_dir,
      "--remote-debugging-port=" .. debugging_port,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
      config.strudel_url
    }
  end

  if config.browser.proxy then
    table.insert(args, "--proxy-server=" .. config.browser.proxy)
  end

  vim.fn.jobstart({ executable, unpack(args) }, {
    -- To prevent hanging Neovim, we don't connect stdio/stderr
    -- The browser process will run in the background.
    -- Users can see browser logs via chrome://inspect
    detach = true,
    on_stdout = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line ~= "" then
          vim.notify(line, vim.log.levels.INFO)
        end
      end
    end,
    on_stderr = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line == "" then
          -- ignore empty lines
        elseif line:match("DevTools listening on ws://") then
          vim.notify(line, vim.log.levels.INFO)
        else
          vim.notify("Browser Process Error: " .. line, vim.log.levels.ERROR)
        end
      end
    end,
    on_exit = function(_, code)
      if code == 0 then
        vim.notify("Browser session closed", vim.log.levels.INFO)
      else
        vim.notify("Browser process error: " .. code, vim.log.levels.ERROR)
      end
    end,
  })
end

function M.attach_editor()
  if attach_job_id ~= nil then
    vim.notify("Strudel is already running, run :StrudelQuit to quit.", vim.log.levels.WARN)
    return
  end

  if not debugging_port then
    debugging_port = read_persisted_debugging_port()
  end

  if not debugging_port then
    vim.notify("No Strudel session to Attach. Run :StrudelStart first.", vim.log.levels.ERROR)
    return
  end

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
  local launch_script = plugin_root .. "/ts/attach.ts"

  local cmd = "node " .. vim.fn.shellescape(launch_script)
  ---@type string
  cmd = cmd .. " --debugging-port=" .. debugging_port
  cmd = cmd .. " --nvim-buffer-name=" .. vim.fn.expand('%:t')

  if config.ui.hide_top_bar then
    cmd = cmd .. " --hide-top-bar"
  end
  if config.ui.maximise_menu_panel then
    cmd = cmd .. " --maximise-menu-panel"
  end
  if config.ui.hide_menu_panel then
    cmd = cmd .. " --hide-menu-panel"
  end
  if config.ui.hide_code_editor then
    cmd = cmd .. " --hide-code-editor"
  end
  if config.ui.hide_error_display then
    cmd = cmd .. " --hide-error-display"
  end
  if custom_css_b64 then
    cmd = cmd .. " --custom-css-b64=" .. vim.fn.shellescape(custom_css_b64)
  end
  -- if config.headless then
  --   cmd = cmd .. " --headless"
  -- end
  if config.log_level then
    cmd = cmd .. " --log-level=" .. vim.fn.shellescape(config.log_level)
  end

  -- Run the js script
  attach_job_id = vim.fn.jobstart(cmd, {
    on_stderr = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line ~= "" then
          vim.notify("Strudel Process Error: " .. line, vim.log.levels.ERROR)
        end
      end
    end,
    on_stdout = function(_, data)
      if not data then
        return
      end

      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(event_queue, line)
        end
      end

      attach_process_event_queue()
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        vim.notify("Detached Cause Error: " .. code, vim.log.levels.ERROR)
      end

      M.detach()
    end,
  })

  set_buffer()
end

function M.detach()
  if attach_job_id then
    vim.fn.jobstop(attach_job_id)
    attach_job_id = nil
    vim.notify("Editor Detached", vim.log.levels.INFO)
  else
    vim.notify("No active Strudel session to detach from", vim.log.levels.WARN)
  end

  attach_job_id = nil
  editor_attached = false
  last_content = nil
  strudel_synced_bufnr = nil
  last_received_cursor = nil
end

-- Combo command to set the current buffer and trigger update
function M.execute()
  local ok = set_buffer()
  if ok then
    vim.defer_fn(function()
      M.update()
    end, SUCCESSIVE_CMD_DELAY * 2)
  end
end

-- function M.is_launched()
--   return strudel_job_id ~= nil
-- end

function M.quit()
  send_message(MESSAGES.QUIT)
  clear_persisted_debugging_port()
end

function M.toggle()
  send_message(MESSAGES.TOGGLE)
end

function M.update()
  send_message(MESSAGES.UPDATE)
end

function M.stop()
  send_message(MESSAGES.STOP)
end

return M
