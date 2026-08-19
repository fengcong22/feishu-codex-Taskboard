$ErrorActionPreference = 'Stop'

$event = @'
{
  "eventId": "demo-event-001",
  "baseToken": "IQWTbOrdwa8GLgsXF3OcLwoUnqe",
  "tableId": "tbl0hb8d1LgVWShb",
  "recordId": "rec_demo_001",
  "recordTitle": "\u6f14\u793a\uff1a\u7b2c\u4e00\u8282\u8bfe",
  "fieldName": "\u89c6\u9891\u6574\u4f53\u8fdb\u5ea6",
  "fieldId": "fld2QXgFUT",
  "beforeValue": "\u7d20\u6750\u9f50\u5168",
  "afterValue": "\u5f85\u526a\u8f91",
  "fields": {
    "\u81ea\u52a8\u526a\u8f91\u9879\u76ee\u5305": "Auto-cut-copyA"
  }
}
'@

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47824/api/simulate/record-changed' -ContentType 'application/json; charset=utf-8' -Body $event
