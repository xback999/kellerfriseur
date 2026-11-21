#!/bin/sh
# Startet die lokale Test-Datenbank (nur für Tests in dieser Umgebung).
su pgu -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgu/data -o '-p 54329 -c listen_addresses=127.0.0.1 -c timezone=UTC -c unix_socket_directories=/tmp' -l /home/pgu/pg.log start" >/dev/null 2>&1
sleep 2
psql -h 127.0.0.1 -p 54329 -U pgu -d postgres -Atc "select 'db-ok'"
