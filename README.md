## What is this app?

Sauron is an app for searching the database (currently only Postgres and ClickHouse are supported) so mostly just running selects and showing results in a pretty format

## Run on Mac
 - install the app
 - run "xattr -cr /Applications/sauron.app" to disable signature verification (it says that the app is damaged without this command);

## Some cool features:
 - formatting json in results
 - saving queries and results of queries
 - you can click on a row and it will open a view with full values of all columns
 - you can go up and down the results table with j and k or with arrow keys

## Quick Demo:

![document symbol](https://github.com/Svovoniks/sauron/blob/master/demo/demo.gif?raw=true)

## Disclaimer
 - This app is mostly ai generated so thare is a ton of weird stuff happening

## Known issues
 - the sql query editor is basiclly a piece of vs code and some vs code shorcuts trigger random popups
 - the query cancellation for postgres is made using a channel in rust (i don't know rust very well, and this seemed like a dead lock safe option) so its theoretecally possible to cancel future queries if you click Abort mulitiple times for one query
 - ctrl+enter shortcut will execute query even if a dialog (new connection, save query...) is shown
