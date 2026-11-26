-- Convert the HTML forms commonly found in Markdown notes to native Word
-- content. Leave mixed/arbitrary HTML and code samples to the normal reader.
local function html_inline(raw)
  if raw.format ~= "html" then return end
  local tag = raw.text:lower()
  if tag:match("^%s*<br%s*/?>%s*$") then return pandoc.LineBreak() end
  if not tag:match("^%s*<img%s") then return end
  local blocks = pandoc.read(raw.text, "html").blocks
  if #blocks ~= 1 or (blocks[1].t ~= "Plain" and blocks[1].t ~= "Para") then return end
  local inlines = blocks[1].content
  if #inlines ~= 1 or inlines[1].t ~= "Image" then return end
  local img = inlines[1]
  local style = img.attributes.style or ""
  local zoom, unit = (style:lower() .. ";"):match("zoom%s*:%s*([%d%.]+)(%%?)%s*;")
  if zoom and not img.attributes.width and not img.attributes.height and pandoc.image then
    local scale = tonumber(zoom)
    if scale and unit == "%" then scale = scale / 100 end
    if scale and scale > 0 and scale <= 10 then
      local ok, mime, bytes = pcall(pandoc.mediabag.fetch, img.src)
      if ok and bytes then
        local valid, size = pcall(pandoc.image.size, bytes)
        if valid and size.width then
          img.attributes.width = string.format("%.1fpx", size.width * scale)
          pandoc.mediabag.insert(img.src, mime, bytes)
        end
      end
    end
  end
  return img
end

local function trim_machine_caption(fig)
  if #fig.content ~= 1 then return end
  local block = fig.content[1]
  if block.t ~= "Plain" and block.t ~= "Para" then return end
  if #block.content ~= 1 or block.content[1].t ~= "Image" then return end
  local image = block.content[1]
  local caption = pandoc.utils.stringify(fig.caption.long)
  local stem = image.src:gsub("[?#].*$", ""):match("([^/\\]+)%.[%w]+$")
  if caption == stem and caption == pandoc.utils.stringify(image.caption) and
      (caption:match("^image%-%d%d%d%d%d%d%d%d%d+") or caption:match("^[%w%-]+_[%w_%-]+$")) then
    fig.caption.long = pandoc.Blocks{}
    return fig
  end
end

local function style_headers(t)
  for _, row in ipairs(t.head.rows) do
    for _, cell in ipairs(row.cells) do
      for _, block in ipairs(cell.contents) do
        if block.t == "Plain" or block.t == "Para" then
          block.content = {pandoc.Span(block.content, {["custom-style"]="Table Heading Text"})}
        end
      end
    end
  end
  return t
end

-- Respect distinct column proportions supplied by the reader. For uniform
-- widths estimate the space each column needs using CJK-aware text lengths.
local function fit_table(t)
  local n = #t.colspecs
  if n < 2 then return end
  local first = t.colspecs[1][2] or 0
  for _, spec in ipairs(t.colspecs) do
    if math.abs((spec[2] or 0) - first) > 0.001 then return end
  end
  local weights, counts = {}, {}
  for i=1,n do weights[i], counts[i] = 0, 0 end
  local function measure(rows)
    for _, row in ipairs(rows) do
      if #row.cells ~= n then return false end
      for i,c in ipairs(row.cells) do
        if c.col_span ~= 1 or c.row_span ~= 1 then return false end
        local value = pandoc.utils.stringify(c.contents)
        if value ~= "" then
          local width = pandoc.layout and pandoc.layout.real_length and
            pandoc.layout.real_length(value) or utf8.len(value)
          weights[i] = weights[i] + math.min(width, 130)
          counts[i] = counts[i] + 1
        end
      end
    end
    return true
  end
  if not measure(t.head.rows) then return end
  for _, body in ipairs(t.bodies) do
    if not measure(body.head) or not measure(body.body) then return end
  end
  if not measure(t.foot.rows) then return end
  local total = 0
  for i=1,n do
    weights[i] = math.max(7, weights[i] / math.max(1,counts[i])) ^ 0.65
    total = total + weights[i]
  end
  local specs = t.colspecs
  for i=1,n do specs[i] = {specs[i][1], 0.3/n + 0.7*weights[i]/total} end
  t.colspecs = specs
  return t
end

return {
  {RawInline=html_inline, RawBlock=function(raw)
    local inline = html_inline(raw)
    if inline then return pandoc.Para{inline} end
  end},
  {Figure=trim_machine_caption, Table=fit_table},
  {Table=style_headers}
}
