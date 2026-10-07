# Evaluate a .podspec under a stub CocoaPods DSL and print what it declared as one JSON object.
# usage: ruby eval.rb <abs podspec path>
# env:   EXPO2SPM_PROJECT_ROOT  the app's ios/ dir (Pod::Config.instance.project_root)
#
# Only stdout carries the JSON; everything the podspec prints (puts, system children) goes to stderr.
require 'json'
require 'pathname'
require 'set'

$expo2spm_warnings = []
$expo2spm_root = nil

def expo2spm_warn(msg)
  $expo2spm_warnings << msg unless $expo2spm_warnings.include?(msg)
end

# What the build would see under `pod install` for an Expo SDK 57 / RN 0.86 app: new arch, Hermes,
# static libraries, sources (never a prebuilt <Pod>.xcframework).
ENV['RCT_NEW_ARCH_ENABLED'] = '1'
ENV['USE_HERMES'] = '1'
ENV['EXPO_USE_SOURCE'] = '1'
ENV.delete('USE_FRAMEWORKS')
$ExpoUseSources = nil

# ---------------------------------------------------------------------------------------------
# Permissive stand-ins
# ---------------------------------------------------------------------------------------------

# Returned for unknown constants and methods: absorbs any call, stringifies to ''.
class Expo2SpmNull < BasicObject
  CONVERSIONS = %i[to_ary to_hash to_proc to_io to_path to_int to_regexp to_sym].freeze
  def initialize(label) = @label = label
  def method_missing(_name, *_args, **_opts, &_blk) = self
  def respond_to_missing?(name, _priv = false) = !CONVERSIONS.include?(name)
  def respond_to?(name, priv = false) = respond_to_missing?(name, priv)
  def to_s = ''
  def to_str = ''
  def to_a = []
  def inspect = "#<expo2spm null #{@label}>"
  def nil? = false
  def ==(other) = equal?(other)
  def !
    false
  end
  def is_a?(_k) = false
  alias kind_of? is_a?
end

# Any unresolved constant (Pod::Lockfile, a helper's module constant, ...) becomes a null object.
class Module
  def const_missing(name)
    expo2spm_warn("unknown constant #{equal?(Object) ? '' : "#{self}::"}#{name} (stubbed)")
    Expo2SpmNull.new(name.to_s)
  end
end

# colored2 / colored: String#yellow etc.
class String
  %i[red green yellow blue magenta cyan white black bold underline italic reverse blink
     light_red light_green light_yellow light_blue light_magenta light_cyan].each do |m|
    define_method(m) { self } unless method_defined?(m)
  end
end

# CocoaPods-only gems and RN's pod scripts are never loaded for real; everything else is.
module Kernel
  alias_method :expo2spm_require, :require
  EXPO2SPM_STUBBED = /\A(colored2?|cocoapods([-\/].*)?|cocoapods-core|xcodeproj|claide|molinillo|fourflusher|nap|concurrent-ruby|active_support.*|activesupport)\z|react_native_pods|scripts\/cocoapods\//
  def require(name)
    if name.to_s.match?(EXPO2SPM_STUBBED)
      expo2spm_warn("require #{name} stubbed") if name.to_s.include?('react_native_pods')
      return true
    end
    expo2spm_require(name)
  rescue LoadError => e
    expo2spm_warn("require #{name} failed (#{e.message}); continuing")
    false
  end
  private :require
end

# ---------------------------------------------------------------------------------------------
# The spec recorder
# ---------------------------------------------------------------------------------------------

class Expo2SpmSpec
  LIST_ATTRS = {
    'source_files' => 'source_files', 'exclude_files' => 'exclude_files',
    'public_header_files' => 'public_header_files', 'private_header_files' => 'private_header_files',
    'project_header_files' => 'private_header_files',
    'frameworks' => 'frameworks', 'framework' => 'frameworks',
    'weak_frameworks' => 'weak_frameworks', 'weak_framework' => 'weak_frameworks',
    'libraries' => 'libraries', 'library' => 'libraries',
    'resources' => 'resources', 'resource' => 'resources',
    'vendored_frameworks' => 'vendored_frameworks', 'vendored_framework' => 'vendored_frameworks',
    'vendored_libraries' => 'vendored_libraries', 'vendored_library' => 'vendored_libraries',
    'swift_versions' => 'swift_versions', 'swift_version' => 'swift_versions',
    'preserve_paths' => 'preserve_paths', 'preserve_path' => 'preserve_paths',
    'default_subspecs' => 'default_subspecs', 'default_subspec' => 'default_subspecs',
  }.freeze
  SCALAR_ATTRS = %w[name version module_name header_dir header_mappings_dir static_framework prepare_command
                    requires_arc module_map].freeze
  HASH_ATTRS = %w[pod_target_xcconfig user_target_xcconfig xcconfig].freeze
  # Metadata that never affects the build.
  BENIGN = %w[summary description license author authors homepage source social_media_url documentation_url
              readme changelog screenshots screenshot cocoapods_version deprecated deprecated_in_favor_of
              requires_app_host test_type app_host_name scheme info_plist pod_target_info_plist
              on_demand_resources].freeze

  attr_reader :data, :parent

  def initialize(name = nil, parent = nil)
    @parent = parent
    @data = {
      'name' => name, 'version' => nil, 'module_name' => nil, 'header_dir' => nil, 'header_mappings_dir' => nil,
      'source_files' => [], 'exclude_files' => [], 'public_header_files' => [], 'private_header_files' => [],
      'dependencies' => {}, 'dependency_configurations' => {},
      'frameworks' => [], 'weak_frameworks' => [], 'libraries' => [], 'compiler_flags' => [],
      'pod_target_xcconfig' => {}, 'user_target_xcconfig' => {}, 'xcconfig' => {},
      'resource_bundles' => {}, 'resources' => [], 'vendored_frameworks' => [], 'vendored_libraries' => [],
      'preserve_paths' => [], 'script_phases' => [], 'platforms' => {}, 'swift_versions' => [],
      'static_framework' => nil, 'prepare_command' => nil, 'requires_arc' => nil, 'module_map' => nil,
      'rn_deps' => false, 'subspecs' => [], 'default_subspecs' => [], 'test_specs' => [], 'other' => {},
    }
  end

  def self.strings(value)
    Array(value).flatten.compact.map(&:to_s)
  end

  def self.xcconfig_hash(value)
    return {} unless value.is_a?(Hash)
    value.each_with_object({}) do |(k, v), h|
      h[k.to_s] = v.is_a?(Array) ? v.flatten.map(&:to_s).join(' ') : v.to_s
    end
  end

  def to_s = full_name
  def full_name = @parent ? "#{@parent.full_name}/#{@data['name']}" : @data['name'].to_s
  def root = @parent ? @parent.root : self
  def to_hash = @data
  def to_json(*a) = @data.to_json(*a)

  # `s.name` reads; `s.name = x` and `s.name x` write. Same for every attribute below.
  def name(*args) = args.empty? ? @data['name'] : (@data['name'] = args.first.to_s)
  def name=(v)
    @data['name'] = v.to_s
  end

  def version(*args) = args.empty? ? @data['version'] : (@data['version'] = args.first.to_s)
  def version=(v)
    @data['version'] = v.to_s
  end

  def dependency(name, *reqs)
    opts = reqs.last.is_a?(Hash) ? reqs.pop : {}
    name = name.to_s
    @data['dependencies'][name] = (@data['dependencies'][name] || []) | reqs.flatten.compact.map(&:to_s)
    if opts[:configurations] || opts['configurations']
      @data['dependency_configurations'][name] = Expo2SpmSpec.strings(opts[:configurations] || opts['configurations'])
    end
    self
  end
  alias dependencies dependency

  def compiler_flags(*args)
    return @data['compiler_flags'] if args.empty?
    @data['compiler_flags'] = Expo2SpmSpec.strings(args)
  end
  def compiler_flags=(v)
    @data['compiler_flags'] = Expo2SpmSpec.strings(v)
  end
  alias compiler_flag compiler_flags
  alias compiler_flag= compiler_flags=

  def platforms(*args)
    return @data['platforms'] if args.empty?
    self.platforms = args.first
  end
  def platforms=(v)
    @data['platforms'] = (v || {}).to_h.transform_keys(&:to_s).transform_values { |x| x&.to_s }
  end

  # `s.platform = :ios, '9.0'` / `s.platform :ios, '9.0'` / `s.platform = :ios`
  def platform(*args)
    return @data['platforms'] if args.empty?
    self.platform = args
  end
  def platform=(v)
    arr = Array(v).flatten
    @data['platforms'] = { arr[0].to_s => arr[1]&.to_s }
  end

  def resource_bundles(*args)
    return @data['resource_bundles'] if args.empty?
    self.resource_bundles = args.first
  end
  def resource_bundles=(v)
    (v || {}).each { |k, globs| @data['resource_bundles'][k.to_s] = Expo2SpmSpec.strings(globs) }
  end
  alias resource_bundle resource_bundles
  alias resource_bundle= resource_bundles=

  def script_phases(*args)
    return @data['script_phases'] if args.empty?
    self.script_phases = args.flatten
  end
  def script_phases=(v)
    phases = v.is_a?(Hash) ? [v] : Array(v)
    @data['script_phases'] += phases.map do |p|
      h = p.to_h.transform_keys(&:to_s)
      { 'name' => h['name'].to_s, 'script' => h['script'].to_s, 'execution_position' => h['execution_position']&.to_s }
    end
  end
  alias script_phase script_phases
  alias script_phase= script_phases=

  def subspec(name, &block)
    child = Expo2SpmSpec.new(name.to_s, self)
    @data['subspecs'] << child
    block&.call(child)
    child
  end

  def test_spec(name = 'Tests', &block)
    sink = Expo2SpmSpec.new(name.to_s, self)
    block&.call(sink)
    @data['test_specs'] << { 'name' => name.to_s, 'source_files' => sink.data['source_files'] }
    sink
  end

  def app_spec(name = 'App', &block)
    sink = Expo2SpmSpec.new(name.to_s, self)
    block&.call(sink)
    expo2spm_warn("app_spec #{name} ignored")
    sink
  end

  def ios = Expo2SpmPlatformProxy.new(self, 'ios')
  def osx = Expo2SpmPlatformProxy.new(self, 'osx')
  def macos = Expo2SpmPlatformProxy.new(self, 'osx')
  def tvos = Expo2SpmPlatformProxy.new(self, 'tvos')
  def watchos = Expo2SpmPlatformProxy.new(self, 'watchos')
  def visionos = Expo2SpmPlatformProxy.new(self, 'visionos')

  def deployment_target(*_) = nil

  def method_missing(meth, *args, &blk)
    m = meth.to_s
    setter = m.end_with?('=')
    key = setter ? m.chomp('=') : m
    reading = !setter && args.empty?
    if (attr = LIST_ATTRS[key])
      return @data[attr] if reading
      @data[attr] = Expo2SpmSpec.strings(args)
    elsif SCALAR_ATTRS.include?(key)
      return @data[key] if reading
      v = args.first
      @data[key] = v.is_a?(String) || v.nil? || v == true || v == false ? v : (v.is_a?(Symbol) ? v.to_s : v)
    elsif HASH_ATTRS.include?(key)
      return @data[key] if reading
      @data[key] = Expo2SpmSpec.xcconfig_hash(args.first)
    elsif BENIGN.include?(key)
      return @data['other'][key] if reading
      @data['other'][key] = args.length == 1 ? args.first : args
    else
      return @data['other'][key] if reading
      expo2spm_warn("unknown spec attribute #{full_name}.#{key}")
      @data['other'][key] = args.length == 1 ? args.first : args
    end
  end

  def respond_to_missing?(_name, _priv = false) = true

  def export
    d = @data.dup
    d['subspecs'] = @data['subspecs'].map(&:export)
    d['other'] = d['other'].keys
    d['static_framework'] = d['static_framework'].nil? ? nil : !!d['static_framework']
    d['requires_arc'] = case d['requires_arc']
                        when nil then nil
                        when true, false then d['requires_arc']
                        else Expo2SpmSpec.strings(d['requires_arc'])
                        end
    d['module_map'] = d['module_map'].nil? ? nil : d['module_map'].to_s
    d['prepare_command'] = d['prepare_command']&.to_s
    %w[name version module_name header_dir header_mappings_dir].each { |k| d[k] = d[k]&.to_s }
    d
  end
end

# `s.ios.x = ...` applies to the spec; other platforms are recorded nowhere (we only build iOS).
class Expo2SpmPlatformProxy
  def initialize(spec, platform)
    @spec = spec
    @platform = platform
  end

  def deployment_target=(v)
    @spec.data['platforms'][@platform] = v.to_s
  end
  def deployment_target(*args) = args.empty? ? @spec.data['platforms'][@platform] : (self.deployment_target = args.first)

  def method_missing(meth, *args, &blk)
    return @spec.public_send(meth, *args, &blk) if @platform == 'ios'
    nil
  end

  def respond_to_missing?(_n, _p = false) = true
end

module Pod
  VERSION = '1.16.2'

  class Spec
    def self.new(name = nil, &block)
      spec = Expo2SpmSpec.new(name)
      block&.call(spec)
      $expo2spm_root ||= spec
      spec
    end
  end
  Specification = Spec

  class Config
    def self.instance = (@instance ||= new)
    def project_root = Pathname.new(ENV['EXPO2SPM_PROJECT_ROOT'] || Dir.pwd)
    def installation_root = project_root
    def project_pods_root = project_root + 'Pods'
    def sandbox_root = project_pods_root
    def podfile_path = project_root + 'Podfile'
    def lockfile_path = project_root + 'Podfile.lock'
    def verbose? = false
    def silent? = true
    def method_missing(meth, *_args)
      expo2spm_warn("Pod::Config##{meth} stubbed")
      Expo2SpmNull.new("Pod::Config##{meth}")
    end
    def respond_to_missing?(_n, _p = false) = true
  end

  module UI
    def self.puts(*args) = $stderr.puts(*args)
    def self.warn(*args) = $stderr.puts(*args)
    def self.info(*args) = $stderr.puts(*args)
    def self.message(*args) = $stderr.puts(*args)
    def self.notice(*args) = $stderr.puts(*args)
    def self.section(*_args) = (yield if block_given?)
    def self.titled_section(*_args) = (yield if block_given?)
    def self.method_missing(*_args) = nil
    def self.respond_to_missing?(_n, _p = false) = true
  end

  class Informative < StandardError; end
end

# ---------------------------------------------------------------------------------------------
# react-native/scripts/react_native_pods.rb + cocoapods/*.rb helpers (RN 0.86.3), and Expo's
# autolinking entry point.
# ---------------------------------------------------------------------------------------------

EXPO2SPM_FOLLY_CONFIG = {
  version: '2024.11.18.00',
  git: 'https://github.com/facebook/folly.git',
  compiler_flags: '-DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32',
  dep_name: 'RCT-Folly/Fabric',
}.freeze

def expo2spm_mark_rn(spec)
  spec.data['rn_deps'] = true if spec.is_a?(Expo2SpmSpec)
end

def install_modules_dependencies(spec, **_opts) = expo2spm_mark_rn(spec)
def depend_on_js_engine(spec) = expo2spm_mark_rn(spec)
def add_rn_third_party_dependencies(spec) = expo2spm_mark_rn(spec)
def add_rncore_dependency(spec) = expo2spm_mark_rn(spec)

def add_dependency(spec, pod_name, subspec: nil, additional_framework_paths: [], framework_name: nil, version: nil, base_dir: nil)
  name = subspec ? "#{pod_name}/#{subspec}" : pod_name
  version ? spec.dependency(name, version) : spec.dependency(name)
end

def get_folly_config = EXPO2SPM_FOLLY_CONFIG
def folly_config = EXPO2SPM_FOLLY_CONFIG
def folly_flags = EXPO2SPM_FOLLY_CONFIG[:compiler_flags]
def get_glog_config = { git: 'https://github.com/google/glog.git' }
def get_fmt_config = { git: 'https://github.com/fmtlib/fmt.git' }
def get_fast_float_config = { git: 'https://github.com/fastfloat/fast_float.git' }
def get_double_conversion_config = { git: 'https://github.com/google/double-conversion.git' }
def get_boost_config = { git: 'https://github.com/react-native-community/boost-for-react-native', compiler_flags: '-Wno-documentation' }
def get_socket_rocket_config = { version: '0.7.1' }
def new_arch_enabled = true
def min_ios_version_supported = '15.1'
def min_supported_versions = { ios: '15.1' }
def resolve_use_frameworks(_spec, header_mappings_dir: nil, module_name: nil) = nil
def create_header_search_path_for_frameworks(*_args, **_opts) = []
def use_expo_modules!(*_args) = nil
def use_react_native!(*_args, **_opts) = nil

module NewArchitectureHelper
  def self.new_arch_enabled = true
  def self.folly_compiler_flags = EXPO2SPM_FOLLY_CONFIG[:compiler_flags]
  def self.install_modules_dependencies(spec, *_args) = expo2spm_mark_rn(spec)
  def self.compute_flags(*_args) = ' -DRCT_NEW_ARCH_ENABLED=1 '
  def self.method_missing(meth, *_args)
    expo2spm_warn("NewArchitectureHelper.#{meth} stubbed")
    nil
  end
  def self.respond_to_missing?(_n, _p = false) = true
end

module ReactNativePodsUtils
  def self.add_dependency(spec, pod_name, *_args, **_opts) = spec.dependency(pod_name)
  def self.create_header_search_path_for_frameworks(*_args, **_opts) = []
  def self.method_missing(meth, *_args)
    expo2spm_warn("ReactNativePodsUtils.#{meth} stubbed")
    nil
  end
  def self.respond_to_missing?(_n, _p = false) = true
end

# The podspec's `self`: unknown helper calls warn and return a null object.
class Expo2SpmSandbox
  def method_missing(meth, *_args, **_opts, &_blk)
    expo2spm_warn("unknown method #{meth} (stubbed)")
    Expo2SpmNull.new(meth.to_s)
  end

  def respond_to_missing?(_n, _p = false) = false
  def get_binding = binding
end

# ---------------------------------------------------------------------------------------------

path = ARGV[0] or abort('usage: ruby eval.rb <abs podspec path>')
path = File.expand_path(path)
out = STDOUT.dup
STDOUT.reopen(STDERR) # podspec chatter and system() children must not reach the JSON stream
$stdout = STDERR

# A trunk .podspec.json (remote pods) is replayed through the same DSL, so it normalizes the same way.
def expo2spm_replay(spec, hash)
  hash.each do |key, value|
    case key
    when 'name' then spec.name = value
    when 'subspecs' then value.each { |sub| spec.subspec(sub['name']) { |ss| expo2spm_replay(ss, sub.reject { |k, _| k == 'name' }) } }
    when 'dependencies' then value.each { |dep, reqs| spec.dependency(dep, *Array(reqs)) }
    when 'ios' then expo2spm_replay(spec.ios, value)
    when 'osx', 'macos', 'tvos', 'watchos', 'visionos', 'testspecs', 'appspecs' then nil
    else spec.public_send("#{key}=", value)
    end
  end
end

error = nil
begin
  Dir.chdir(File.dirname(path))
  if path.end_with?('.json')
    Pod::Spec.new { |s| expo2spm_replay(s, JSON.parse(File.read(path))) }
  else
    Expo2SpmSandbox.new.get_binding.eval(File.read(path), path, 1)
  end
rescue Exception => e # rubocop:disable Lint/RescueException
  error = "#{e.class}: #{e.message} (#{e.backtrace&.first(3)&.join(' <- ')})"
end

result = { 'error' => error, 'warnings' => $expo2spm_warnings, 'spec' => $expo2spm_root&.export }
out.write(JSON.generate(result))
out.write("\n")
out.flush
exit(error && !$expo2spm_root ? 1 : 0)
