local M = {}

local uv = vim.loop

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

M.debugging_port = get_free_port()

---Strips desktop field codes (e.g., %f, %u) from command arguments.
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

---Finds the local Strudel PWA command from .desktop files.
---@return { executable: string, args: table<string, string> } | nil
function M.get_local_pwa_command()
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
    local name, type = uv.fs_scandir_next(handle)
    if not name then
      break
    end

    if name:match("%.desktop$") then
      local file_path = applications_dir .. "/" .. name
      local file = io.open(file_path, "r")
      if file then
        local content = file:read("*a")
        file:close()

        local in_desktop_entry = false
        local app_name = nil
        local exec_cmd = nil

        for line in content:gmatch("[^\\r\\n]+") do
          line = line:match("^%s*(.-)%s*$") -- trim
          if #line > 0 and not line:match("^#") then
            if line:match("^%[") and line:match("%]$") then
              in_desktop_entry = (line == "[Desktop Entry]")
            elseif in_desktop_entry then
              local eq = line:find("=")
              if eq then
                local key = line:sub(1, eq - 1)
                local value = line:sub(eq + 1)
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
          local executable = table.remove(tokens, 1)
          if executable then
            local args = {}
            for _, arg in ipairs(tokens) do
              if arg:match("^--") then
                local parts = {}
                for part in arg:gmatch("([^=]+)") do
                  table.insert(parts, part)
                end
                local key = parts[1]
                local value = #parts > 1 and table.concat(parts, "=", 2) or ""
                args[key] = value
              end
            end
            return { executable = executable, args = args }
          end
        end
      end
    end
  end
  return nil
end

---Launches the browser process for the Strudel PWA.
---@param user_brawser_exec_path string | nil The user-specified browser executable path.
---@param headless boolean Whether to launch the browser in headless mode (currently unused).
function M.start_browser_process(user_brawser_exec_path, headless)
  local pwa_command = M.get_local_pwa_command()
  local home = os.getenv("HOME")
  local user_data_dir = home .. "/.cache/strudelPWA-nvim"

  local args
  local executable

--  local user_data_dir_arg = "--user-data-dir=" .. user_data_dir

  if pwa_command and pwa_command.args["--user-data-dir"] then
    executable = pwa_command.executable
    args = {
      "--user-data-dir=" .. user_data_dir,
      "--profile-directory=Default",
      "--app-id=camedmhajlokcgipjhegkdobhmafconk",
      "--remote-debugging-port=" .. M.debugging_port,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
    }
  else
    executable = user_brawser_exec_path or "chrome"
    args = {
      "--profile-directory=Default",
      "--user-data-dir=" .. user_data_dir,
      "--remote-debugging-port=" .. M.debugging_port,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
    }
  end

  vim.fn.jobstart({ executable, unpack(args) }, {
    detach = true,
    -- To prevent hanging Neovim, we don't connect stdio/stderr
    -- The browser process will run in the background.
    -- Users can see browser logs via chrome://inspect
  })
end

return M
